import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { createApp } from '../src/app.js';
import { createAuthRouter } from '../src/gateway/googleAuth.js';
import { createServiceClients } from '../src/shared/serviceClients.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3001/api/auth/google/callback',
  sessionSecret: 'test-session-secret-test-session-secret',
  frontendUrl: 'http://frontend.test',
  secureCookies: false,
};

// Real URL building (PKCE, state, nonce), Google itself is simulated.
class FakeGoogle extends OAuth2Client {
  mode = 'ok';
  calls = 0;
  nonce = '';
  async getToken() {
    this.calls += 1;
    if (this.mode === 'invalid_grant') {
      throw Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
    }
    if (this.mode === 'down') throw new Error('ECONNREFUSED');
    return { tokens: { id_token: 'fake' } };
  }
  async verifyIdToken() {
    return { getPayload: () => ({ sub: 'g-1', email: 'Richard@Example.cz', email_verified: true, name: 'Richard', picture: 'p', nonce: this.nonce }) };
  }
}

let server;
let base;
let google;
let events;
let auditFails = false;

before(async () => {
  google = new FakeGoogle({ clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
  events = [];
  const clients = {
    ...createServiceClients(),
    audit: {
      request: async (path, options) => {
        if (auditFails) throw new Error('audit down');
        events.push({ path, ...options });
      },
    },
  };
  server = createApp({ clients, authRouter: createAuthRouter({ clients, config, oauthClient: google }) }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });
const cookies = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

async function start() {
  const res = await get('/auth/google');
  const location = new URL(res.headers.get('location'));
  google.nonce = location.searchParams.get('nonce');
  return { res, location, cookie: cookies(res), state: location.searchParams.get('state') };
}
const callback = (s, query) => get(`/auth/google/callback?${query}`, { cookie: s.cookie });
const errorOf = (res) => new URL(res.headers.get('location')).searchParams.get('error');

test('start přesměruje na Google s PKCE, state, nonce a scopes', async () => {
  const { res, location } = await start();
  assert.equal(res.status, 302);
  assert.equal(location.host, 'accounts.google.com');
  assert.equal(location.searchParams.get('scope'), 'openid email profile');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), config.redirectUri);
});

test('happy day: session, audit událost a nový účet, podruhé bez duplicity', async () => {
  const before = events.length;
  const s = await start();
  const res = await callback(s, `code=good&state=${s.state}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), config.frontendUrl);
  const session = cookies(res);
  assert.match(session, /gr_session=/);
  assert.match(res.headers.getSetCookie().find((c) => c.startsWith('gr_session')), /HttpOnly/i);

  const event = events[before];
  assert.equal(event.path, '/internal/events');
  assert.equal(event.body.type, 'auth.login');
  assert.equal(event.body.source, 'gateway');
  assert.equal(event.body.data.outcome, 'success');
  assert.equal(event.body.data.userCreated, true);

  const me = await (await get('/auth/me', { cookie: session })).json();
  assert.equal(me.email, 'Richard@Example.cz');

  const s2 = await start();
  const res2 = await callback(s2, `code=good&state=${s2.state}`);
  const me2 = await (await get('/auth/me', { cookie: cookies(res2) })).json();
  assert.equal(events.at(-1).body.data.userCreated, false);
  assert.equal(me2.id, me.id);
});

test('A1: uživatel odmítl souhlas', async () => {
  const s = await start();
  assert.equal(errorOf(await callback(s, `error=access_denied&state=${s.state}`)), 'cancelled');
});

test('A2: Google vrátil chybu nebo je nedostupný', async () => {
  let s = await start();
  assert.equal(errorOf(await callback(s, `error=server_error&state=${s.state}`)), 'google_error');
  s = await start();
  google.mode = 'down';
  try {
    assert.equal(errorOf(await callback(s, `code=good&state=${s.state}`)), 'google_error');
  } finally {
    google.mode = 'ok';
  }
});

test('A3: špatný nebo chybějící state, Google se nevolá, audit je podezřelý', async () => {
  const s = await start();
  const calls = google.calls;
  const before = events.length;
  const res = await callback(s, 'code=good&state=WRONG');
  assert.equal(errorOf(res), 'invalid_state');
  assert.equal(google.calls, calls);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).body.data.outcome, 'suspicious');
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('gr_session')));

  assert.equal(errorOf(await get('/auth/google/callback?code=good&state=x')), 'invalid_state');
});

test('A4: neplatný nebo expirovaný kód', async () => {
  const s = await start();
  google.mode = 'invalid_grant';
  try {
    assert.equal(errorOf(await callback(s, `code=old&state=${s.state}`)), 'invalid_code');
  } finally {
    google.mode = 'ok';
  }
});

test('nedostupný audit přihlášení nezablokuje', async () => {
  auditFails = true;
  try {
    const s = await start();
    const res = await callback(s, `code=good&state=${s.state}`);
    assert.equal(res.headers.get('location'), config.frontendUrl);
  } finally {
    auditFails = false;
  }
});

test('/me bez session vrací 401, logout vrací 204', async () => {
  const me = await get('/auth/me');
  assert.equal(me.status, 401);
  assert.equal((await me.json()).code, 'NOT_AUTHENTICATED');
  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST' })).status, 204);
});

test('bez Google konfigurace gateway běží a /api/auth vrací 503', async () => {
  const clients = createServiceClients();
  const app = createApp({ clients, authRouter: createAuthRouter({ clients, config: { ...config, clientId: '' } }) }).listen(0);
  await once(app, 'listening');
  try {
    const url = `http://127.0.0.1:${app.address().port}/api`;
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const res = await fetch(`${url}/auth/google`, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'AUTH_NOT_CONFIGURED');
  } finally {
    app.close();
  }
});
