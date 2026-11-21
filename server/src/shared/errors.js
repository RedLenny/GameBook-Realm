export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve().then(() => handler(req, res, next)).catch(next);

export function notFound(_req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Nenalezeno'));
}

const parserErrors = {
  'entity.parse.failed': [400, 'INVALID_JSON', 'Neplatný JSON'],
  'entity.too.large': [413, 'PAYLOAD_TOO_LARGE', 'Požadavek je příliš velký'],
  'encoding.unsupported': [415, 'UNSUPPORTED_ENCODING', 'Nepodporované kódování'],
  'charset.unsupported': [415, 'UNSUPPORTED_CHARSET', 'Nepodporovaná znaková sada'],
};

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let error = err;
  if (!(error instanceof AppError)) {
    const parserError = parserErrors[err.type];
    if (parserError) {
      error = new AppError(...parserError);
    } else if (err instanceof URIError) {
      error = new AppError(400, 'INVALID_URL', 'Neplatná URL');
    } else {
      console.error({ requestId: req.requestId, error: err });
      error = new AppError(500, 'INTERNAL_ERROR', 'Interní chyba serveru');
    }
  }

  res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(req.requestId && { requestId: req.requestId }),
    ...(error.details !== undefined && { details: error.details }),
  });
}
