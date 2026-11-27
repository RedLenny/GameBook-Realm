import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export function internalAuth(token, { required = false } = {}) {
  return (req, _res, next) => {
    if (!token) {
      if (required) return next(new AppError(503, 'SERVICE_AUTH_NOT_CONFIGURED', 'Chybí servisní token'));
      return next();
    }
    const expected = Buffer.from(token);
    const actual = Buffer.from(req.get('x-service-token') || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return next(new AppError(401, 'INVALID_SERVICE_TOKEN', 'Neplatné přihlašovací údaje služby'));
    }
    next();
  };
}

// Only the gateway supplies this header, after verifying the signed session.
export function gatewayPlayer(token) {
  return [internalAuth(token, { required: true }), (req, _res, next) => {
    const playerId = req.get('x-player-id');
    if (!playerId || !/^[a-zA-Z0-9_-]{1,200}$/.test(playerId)) {
      return next(new AppError(401, 'NOT_AUTHENTICATED', 'Nejste přihlášen.'));
    }
    req.playerId = playerId;
    next();
  }];
}
