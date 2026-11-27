import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { googleAuth } from '../config.js';
import { AppError, asyncHandler } from '../shared/errors.js';
import { createAuditClient } from '../shared/auditClient.js';
import { createUsersStore } from '../store/usersStore.js';

/**
 * Login flow (Google OAuth 2.0 / OIDC), system use case "Authentication (Google OAuth)".
 *
 *   GET  /api/auth/google           creates state, redirects to Google
 *   GET  /api/auth/google/callback  checks state, exchanges the code, finds or creates the user,
 *                                   writes an audit event, creates the session, redirects to the frontend
 *   POST /api/auth/logout           clears the session
 *   GET  /api/auth/me               TEMPORARY, replaced by "Token verification and profile resolution"
 *
 * Failures redirect to <frontend>/login?error=<code>:
 *   cancelled      A1 user denied consent
 *   google_error   A2 Google returned an error or is unavailable
 *   invalid_state  A3 state mismatch or missing (audited as suspicious, Google is not called)
 *   invalid_code   A4 invalid or expired authorization code
 */

export const SESSION_COOKIE = 'gr_session';
const TX_COOKIE = 'gr_oauth_tx';
const TX_MAX_AGE_MS = 10 * 60 * 1000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const ISSUER = 'gamebook-realm-gateway';

const isConfigured = (config) => ['clientId', 'clientSecret', 'redirectUri', 'sessionSecret']
  .every((key) => Boolean(config[key]));

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function readSession(req, config = googleAuth) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, config.sessionSecret, { issuer: ISSUER, algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

export function createAuthRouter({
  clients,
  config = googleAuth,
  usersStore = createUsersStore(),
  oauthClient,
} = {}) {
  const router = Router();

  if (!isConfigured(config)) {
    // The gateway still starts without Google credentials (tests, other tasks).
    router.use((_req, _res, next) => next(
      new AppError(503, 'AUTH_NOT_CONFIGURED', 'Přihlášení přes Google není nakonfigurováno'),
    ));
    return router;
  }

  const google = oauthClient ?? new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
  const audit = createAuditClient(clients.audit, 'gateway');
  const cookieBase = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies };

  // Audit must never block the login itself, a failure is only logged.
  async function record(event, requestId) {
    try {
      await audit.record(event, { requestId });
    } catch (error) {
      console.error({ requestId, message: 'audit event failed', error: error.message });
    }
  }
  const fail = (res, code) => res.redirect(`${config.frontendUrl}/login?error=${encodeURIComponent(code)}`);

  router.use(cookieParser(config.sessionSecret));

  router.get('/google', asyncHandler(async (_req, res) => {
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = await google.generateCodeVerifierAsync();
    res.cookie(TX_COOKIE, JSON.stringify({ state, nonce, codeVerifier }), {
      ...cookieBase, signed: true, maxAge: TX_MAX_AGE_MS,
    });
    res.redirect(google.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }));
  }));

  router.get('/google/callback', asyncHandler(async (req, res) => {
    const raw = req.signedCookies?.[TX_COOKIE];
    res.clearCookie(TX_COOKIE, cookieBase);

    let tx = null;
    try {
      tx = raw ? JSON.parse(raw) : null;
    } catch {
      tx = null;
    }

    // A3: state missing or different. No request to Google, suspicious event to audit.
    if (!tx || typeof req.query.state !== 'string' || !safeEqual(req.query.state, tx.state)) {
      await record({ type: 'auth.login', data: { method: 'google', outcome: 'suspicious', reason: 'state_mismatch_or_missing' } }, req.requestId);
      return fail(res, 'invalid_state');
    }

    // A1 / A2: Google reported an error
    if (req.query.error) return fail(res, req.query.error === 'access_denied' ? 'cancelled' : 'google_error');
    if (typeof req.query.code !== 'string' || !req.query.code) return fail(res, 'invalid_code');

    let payload;
    try {
      const { tokens } = await google.getToken({ code: req.query.code, codeVerifier: tx.codeVerifier });
      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      payload = ticket.getPayload();
    } catch (error) {
      // A4: invalid or expired code, otherwise A2: Google failed or is not reachable.
      const invalidGrant = error?.response?.data?.error === 'invalid_grant';
      console.error({ requestId: req.requestId, message: 'google login failed', error: error.message });
      return fail(res, invalidGrant ? 'invalid_code' : 'google_error');
    }

    if (!payload || payload.nonce !== tx.nonce) {
      await record({ type: 'auth.login', data: { method: 'google', outcome: 'suspicious', reason: 'nonce_mismatch' } }, req.requestId);
      return fail(res, 'invalid_state');
    }
    if (typeof payload.sub !== 'string' || !payload.sub || !payload.email || !payload.email_verified) {
      return fail(res, 'google_error');
    }

    const { user, created } = await usersStore.findOrCreate({
      googleSub: payload.sub,
      email: payload.email,
      name: payload.name,
    });

    await record({
      type: 'auth.login',
      entityId: user.id,
      data: { method: 'google', outcome: 'success', email: user.email, userCreated: created },
    }, req.requestId);

    const session = jwt.sign(
      { sub: user.id, email: user.email, name: user.name, picture: payload.picture },
      config.sessionSecret,
      { algorithm: 'HS256', issuer: ISSUER, expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000) },
    );
    res.cookie(SESSION_COOKIE, session, { ...cookieBase, maxAge: SESSION_MAX_AGE_MS });
    return res.redirect(config.frontendUrl);
  }));

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieBase);
    res.status(204).end();
  });

  router.get('/me', (req, res) => {
    const session = readSession(req, config);
    if (!session) throw new AppError(401, 'NOT_AUTHENTICATED', 'Nejste přihlášen');
    res.json({ id: session.sub, email: session.email, name: session.name, picture: session.picture });
  });

  return router;
}
