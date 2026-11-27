import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import express, { Router } from 'express';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { createGameplayApp } from '../src/services/gameplay/app.js';
import { createDiscoveryApp } from '../src/services/discovery/app.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createServiceClient } from '../src/shared/serviceClient.js';
import { createServiceClients } from '../src/shared/serviceClients.js';
import { createAuditClient } from '../src/shared/auditClient.js';
import { validateDtoIn } from '../src/shared/validation.js';
import { AppError, asyncHandler } from '../src/shared/errors.js';

async function serve(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

const jsonOptions = (body, headers = {}) => ({
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function stack(t, { storyRouter, timeoutMs = 2000, auditDb } = {}) {
  const token = 'integration-service-token';
  const audit = await serve(t, createAuditApp({ token, ...(auditDb && { db: auditDb }) }));
  const auditClient = createServiceClient({ name: 'audit', url: audit.url, token, timeoutMs });
  const story = await serve(t, createStoryApp({ token, clients: { audit: auditClient }, router: storyRouter }));
  const storyClient = createServiceClient({ name: 'story', url: story.url, token, timeoutMs });
  const gameplay = await serve(t, createGameplayApp({ token, clients: { story: storyClient, audit: auditClient } }));
  const discovery = await serve(t, createDiscoveryApp({ token, clients: { story: storyClient } }));
  const clients = createServiceClients({ definitions: { story, gameplay, discovery, audit }, token, timeoutMs });
  const gateway = await serve(t, createApp({ clients }));
  return { gateway, story, gameplay, discovery, audit, clients, token };
}

test('gateway routes to independent services and readiness checks dependencies over HTTP', async (t) => {
  const { gateway } = await stack(t);
  for (const [path, service] of [
    ['/api/stories', 'story'], ['/api/playthroughs', 'gameplay'], ['/api/discovery', 'discovery'],
  ]) {
    const health = await fetch(`${gateway.url}${path}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, service);
    const ready = await fetch(`${gateway.url}${path}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ok');
  }
  const ready = await fetch(`${gateway.url}/api/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual((await ready.json()).services, {
    story: { status: 'ok' }, gameplay: { status: 'ok' },
    discovery: { status: 'ok' }, audit: { status: 'ok' },
  });
  for (const path of ['/internal/events', '/api/audit/events', '/api/stories-else/health']) {
    assert.equal((await fetch(`${gateway.url}${path}`)).status, 404);
  }
});

test('gateway preserves method, path, query, JSON, auth, request ID and service errors', async (t) => {
  const router = Router();
  const schema = z.object({
    body: z.object({ title: z.string().trim().min(1) }).strict(),
    params: z.object({ id: z.string().uuid() }),
    query: z.object({ genre: z.string() }),
  });
  router.post('/:id', validateDtoIn(schema), (req, res) => {
    res.status(201).json({ dtoIn: req.dtoIn, requestId: req.requestId, auth: req.get('authorization') });
  });
  router.delete('/:id', (_req, res) => res.status(204).end());
  router.get('/conflict', asyncHandler(async () => {
    throw new AppError(409, 'STORY_CONFLICT', 'Příběh nelze publikovat');
  }));
  const { gateway } = await stack(t, { storyRouter: router });
  const id = randomUUID();
  const created = await fetch(`${gateway.url}/api/stories/${id}?genre=sci-fi`, jsonOptions(
    { title: '  Test  ' }, { 'x-request-id': 'trace-123', authorization: 'Bearer example' },
  ));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-request-id'), 'trace-123');
  assert.deepEqual(await created.json(), {
    dtoIn: { body: { title: 'Test' }, params: { id }, query: { genre: 'sci-fi' } },
    requestId: 'trace-123', auth: 'Bearer example',
  });
  const invalid = await fetch(`${gateway.url}/api/stories/${id}?genre=fantasy`, jsonOptions({ title: '' }));
  assert.equal(invalid.status, 400);
  const validation = await invalid.json();
  assert.equal(validation.code, 'VALIDATION_ERROR');
  assert.equal(validation.details[0].path, 'body.title');
  assert.equal(validation.requestId, invalid.headers.get('x-request-id'));
  const conflict = await fetch(`${gateway.url}/api/stories/conflict`);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'STORY_CONFLICT');
  const removed = await fetch(`${gateway.url}/api/stories/${id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), '');
  const head = await fetch(`${gateway.url}/api/stories/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('audit client sends validated, authenticated and idempotent events between services', async (t) => {
  // Audit Service ukládá události do MongoDB, test proto dostane dočasnou databázi v paměti.
  const mongo = await MongoMemoryServer.create();
  const mongoClient = await new MongoClient(mongo.getUri()).connect();
  t.after(async () => { await mongoClient.close(); await mongo.stop(); });
  const { audit, clients, token } = await stack(t, { auditDb: mongoClient.db('infrastructure_audit') });
  const client = createAuditClient(clients.audit, 'story');
  const event = { id: randomUUID(), type: 'story.published', entityId: 'story-1', occurredAt: new Date().toISOString() };
  const first = await client.record(event, { requestId: 'publish-trace' });
  const second = await client.record(event, { requestId: 'retry-trace' });
  assert.deepEqual(second, first);
  assert.equal(first.requestId, 'publish-trace');
  assert.equal(first.event.source, 'story');
  const events = await clients.audit.request('/internal/events?limit=1');
  assert.equal(events.length, 1);
  assert.equal(events[0].event.id, event.id);
  await assert.rejects(client.record({ ...event, type: 'story.deleted' }), { status: 409, code: 'EVENT_ID_CONFLICT' });
  await assert.rejects(clients.audit.request('/internal/events', {
    method: 'POST', body: { type: 'bad' },
  }), { status: 400, code: 'VALIDATION_ERROR' });
  await assert.rejects(clients.audit.request('/internal/events?limit=0'), { status: 400 });
  for (const credentials of ['', 'wrong-token']) {
    const res = await fetch(`${audit.url}/internal/events`, { headers: { 'x-service-token': credentials } });
    assert.equal(res.status, 401);
  }
  assert.equal((await fetch(`${audit.url}/internal/health`, { headers: { 'x-service-token': token } })).status, 200);
});

test('gateway stays alive when a dependency fails and reports 502/503 consistently', async (t) => {
  const { gateway, story } = await stack(t);
  await story.close();
  const response = await fetch(`${gateway.url}/api/stories/health`);
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(error.requestId, response.headers.get('x-request-id'));
  assert.equal((await fetch(`${gateway.url}/api/health`)).status, 200);
  const readiness = await fetch(`${gateway.url}/api/ready`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).details.story.code, 'SERVICE_UNAVAILABLE');
  assert.equal((await fetch(`${gateway.url}/api/discovery/ready`)).status, 503);
});

test('service client and gateway enforce timeout including response-body reads', async (t) => {
  const slow = express();
  slow.get('/api/stories/slow', (_req, res) => {
    res.set('content-type', 'application/json');
    res.flushHeaders();
    const timer = setTimeout(() => res.end('{"ok":true}'), 500);
    res.once('close', () => clearTimeout(timer));
  });
  const upstream = await serve(t, slow);
  const client = createServiceClient({ name: 'story', url: upstream.url, timeoutMs: 80 });
  const gateway = await serve(t, createApp({ clients: { story: client } }));
  const response = await fetch(`${gateway.url}/api/stories/slow`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'SERVICE_TIMEOUT');
});

test('service client rejects invalid or oversized responses and does not follow redirects or retry mutations', async (t) => {
  let hits = 0;
  const upstream = express();
  upstream.get('/invalid', (_req, res) => res.send('not JSON'));
  upstream.get('/large', (_req, res) => res.json({ text: 'x'.repeat(1024 * 1024) }));
  upstream.get('/redirect', (_req, res) => res.redirect('/target'));
  upstream.get('/target', (_req, res) => { hits++; res.json({ ok: true }); });
  upstream.post('/mutation', (_req, res) => { hits++; res.status(503).json({ error: 'Down', code: 'DOWN' }); });
  const server = await serve(t, upstream);
  const client = createServiceClient({ name: 'test', url: server.url });
  for (const path of ['/invalid', '/large', '/redirect']) {
    await assert.rejects(client.request(path), { status: 502, code: 'INVALID_SERVICE_RESPONSE' });
  }
  assert.equal(hits, 0);
  await assert.rejects(client.request('/mutation', { method: 'POST', body: {} }), { status: 503, code: 'DOWN' });
  assert.equal(hits, 1);
  await assert.rejects(client.request('//other-host/secret'), /absolute path/);
});

test('shared middleware handles invalid JSON, large bodies, invalid IDs, async failures and CORS', async (t) => {
  const router = Router();
  router.get('/crash', asyncHandler(async () => { throw new Error('private database credentials'); }));
  t.mock.method(console, 'error', () => {});
  const { gateway } = await stack(t, { storyRouter: router });
  for (const [body, status, code] of [
    ['{', 400, 'INVALID_JSON'],
    [JSON.stringify({ name: 'x'.repeat(110000) }), 413, 'PAYLOAD_TOO_LARGE'],
    [JSON.stringify({ name: 42 }), 400, 'VALIDATION_ERROR'],
  ]) {
    const response = await fetch(`${gateway.url}/api/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  const invalidId = await fetch(`${gateway.url}/api/items/9007199254740993`, { method: 'DELETE' });
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).error, 'Neplatné id');
  const crash = await fetch(`${gateway.url}/api/stories/crash`);
  assert.equal(crash.status, 500);
  const data = await crash.json();
  assert.equal(data.error, 'Interní chyba serveru');
  assert.equal(data.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(data).includes('credentials'));
  const preflight = await fetch(`${gateway.url}/api/stories`, {
    method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const unsupported = await fetch(`${gateway.url}/api/stories/test`, { method: 'POST', body: 'plain text' });
  assert.equal(unsupported.status, 415);
});

test('gateway cannot be used to reach internal service endpoints via encoded traversal', async (t) => {
  const { gateway } = await stack(t);
  const response = await new Promise((resolve, reject) => {
    const req = http.get(`${gateway.url}/api/stories/..%2f..%2finternal/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INVALID_URL');
});
