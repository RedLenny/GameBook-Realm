import { AppError, asyncHandler } from '../shared/errors.js';

export function proxyToService(prefix, client) {
  return asyncHandler(async (req, res) => {
    const target = new URL(req.originalUrl, 'http://gateway.local');
    const decodedPath = decodeURIComponent(target.pathname);
    if (!(decodedPath === prefix || decodedPath.startsWith(`${prefix}/`))
        || decodedPath.includes('\\') || decodedPath.split('/').some((part) => part === '.' || part === '..')) {
      throw new AppError(400, 'INVALID_URL', 'Neplatná URL');
    }

    const hasBody = Number(req.get('content-length')) > 0 || Boolean(req.get('transfer-encoding'));
    if (hasBody && !req.is('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Očekáván Content-Type application/json');
    }
    if (hasBody && ['GET', 'HEAD'].includes(req.method)) {
      throw new AppError(400, 'UNEXPECTED_BODY', 'Tato metoda nepřijímá tělo požadavku');
    }

    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const response = await client.send(`${target.pathname}${target.search}`, {
        method: req.method,
        ...(hasBody && { body: req.body }),
        requestId: req.requestId,
        authorization: req.get('authorization'),
        signal: controller.signal,
      });
      if (res.destroyed) return;
      res.status(response.status);
      for (const header of ['content-type', 'cache-control', 'retry-after', 'allow']) {
        const value = response.headers.get(header);
        if (value) res.set(header, value);
      }
      res.end(response.text);
    } finally {
      res.off('close', cancel);
    }
  });
}
