import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export function internalAuth(token) {
  return (req, _res, next) => {
    if (!token) return next();
    const expected = Buffer.from(token);
    const actual = Buffer.from(req.get('x-service-token') || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return next(new AppError(401, 'INVALID_SERVICE_TOKEN', 'Neplatné přihlašovací údaje služby'));
    }
    next();
  };
}
