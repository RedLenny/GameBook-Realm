import { randomUUID } from 'node:crypto';

export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[a-zA-Z0-9_-]{1,100}$/.test(incoming)
    ? incoming
    : randomUUID();
  res.set('x-request-id', req.requestId);
  next();
}
