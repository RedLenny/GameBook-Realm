import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { createServiceClient } from '../src/shared/serviceClient.js';

// story/create (Command createStory v Application Modelu): autor Jan zakládá „Ztracený důkaz“.
const token = 'story-create-test-service';
const sessionSecret = 'story-create-test-session-secret';
const servers = [];
const clients = {};
let mongo, client, gateway, storyUrl;

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function service(name, factory, options = {}) {
  const url = await serve(factory({ db: client.db('storyCreate_' + name), token, clients, ...options }));
  clients[name] = createServiceClient({ name, url, token });
  return url;
}
const cookie = (sub) => 'gr_session=' + jwt.sign({ sub }, sessionSecret, {
  algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
});
function create(body, { as = 'jan', url = gateway } = {}) {
  return fetch(url + '/api/stories/story/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as && { cookie: cookie(as) }) },
    body: JSON.stringify(body),
  });
}
const auditLog = () => client.db('storyCreate_audit').collection('auditLog');

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  await service('audit', createAuditApp);
  storyUrl = await service('story', createStoryApp);
  gateway = await serve(createApp({ clients, sessionConfig: { sessionSecret } }));
});
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  await client?.close();
  await mongo?.stop();
});

test('story/create stores a draft owned by the caller and writes a success audit record', async () => {
  const res = await create({
    name: '  Ztracený důkaz ',
    description: 'Detektivní příběh, ve kterém pátráte po důkazu v městské kavárně.',
    genre: 'Detektivka',
  });
  assert.equal(res.status, 201);
  const { story, uuAppErrorMap } = await res.json();
  assert.deepEqual(uuAppErrorMap, {});
  assert.match(story.id, /^[0-9a-f]{24}$/);
  assert.equal(story.authorId, 'jan');
  assert.equal(story.name, 'Ztracený důkaz');
  assert.equal(story.genre, 'Detektivka');
  assert.equal(story.state, 'draft');
  assert.equal(story.publishedAt, null);
  assert.equal(story.createdAt, story.updatedAt);
  assert.ok(!Number.isNaN(Date.parse(story.createdAt)));

  const stored = await client.db('storyCreate_story').collection('stories').findOne();
  assert.equal(stored._id.toHexString(), story.id);
  assert.equal(stored.state, 'draft');
  assert.equal(await client.db('storyCreate_story').collection('scenes').countDocuments(), 0);

  const record = await auditLog().findOne({ entityId: story.id });
  assert.equal(record.operation, 'story/create');
  assert.equal(record.entityType, 'story');
  assert.equal(record.storyId.toHexString(), story.id);
  assert.equal(record.actorId, 'jan');
  assert.deepEqual(record.actorProfiles, ['Users']);
  assert.equal(record.result, 'success');
  assert.deepEqual(record.detail, { name: 'Ztracený důkaz', genre: 'Detektivka' });
  assert.equal(record.requestId, res.headers.get('x-request-id'));
});

test('story/create applies defaults and ignores unsupported keys with a warning', async () => {
  const res = await create({ name: 'Ztracený důkaz', genre: '  ', state: 'published', authorId: 'petr' });
  assert.equal(res.status, 201);
  const { story, uuAppErrorMap } = await res.json();
  assert.equal(story.description, '');
  assert.equal(story.genre, null);
  assert.equal(story.state, 'draft');
  assert.equal(story.authorId, 'jan');
  assert.deepEqual(uuAppErrorMap.unsupportedKeys.unsupportedKeyList.sort(), ['authorId', 'state']);
});

test('story/create rejects invalid dtoIn without storing anything', async () => {
  const before = await client.db('storyCreate_story').collection('stories').countDocuments();
  const cases = [
    [{}, 'missingKeyMap', 'name'],
    [{ name: '   ' }, 'invalidValueKeyMap', 'name'],
    [{ name: 'x'.repeat(121) }, 'invalidValueKeyMap', 'name'],
    [{ name: 42 }, 'invalidTypeKeyMap', 'name'],
    [{ name: 'Ztracený důkaz', description: 'x'.repeat(2001) }, 'invalidValueKeyMap', 'description'],
    [{ name: 'Ztracený důkaz', genre: 'x'.repeat(51) }, 'invalidValueKeyMap', 'genre'],
  ];
  for (const [body, map, key] of cases) {
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    const error = await res.json();
    assert.equal(error.code, 'invalidDtoIn');
    assert.ok(Object.hasOwn(error.details[map], key), `${key} in ${map}`);
  }
  assert.equal(await client.db('storyCreate_story').collection('stories').countDocuments(), before);
});

test('story/create requires a signed-in user and is not reachable around the gateway', async () => {
  const anonymous = await create({ name: 'Ztracený důkaz' }, { as: null });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'NOT_AUTHENTICATED');

  const forged = await fetch(gateway + '/api/stories/story/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-player-id': 'jan' },
    body: JSON.stringify({ name: 'Ztracený důkaz' }),
  });
  assert.equal(forged.status, 401);

  // Přímé volání služby bez servisního tokenu neprojde ani s hlavičkou hráče.
  const direct = await create({ name: 'Ztracený důkaz' }, { url: storyUrl });
  assert.equal(direct.status, 401);
  assert.equal((await direct.json()).code, 'INVALID_SERVICE_TOKEN');
});

test('story/create reports storyCreateFailed and audits the error when the database fails', async () => {
  const failing = { collection: () => ({ insertOne: () => Promise.reject(new Error('db down')) }) };
  const url = await serve(createStoryApp({ db: failing, token, clients }));
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(url + '/api/stories/story/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': token, 'x-player-id': 'jan' },
      body: JSON.stringify({ name: 'Ztracený důkaz' }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'storyCreateFailed');
  } finally {
    console.error = original;
  }
  const record = await auditLog().findOne({ result: 'error' });
  assert.equal(record.operation, 'story/create');
  assert.equal(record.errorCode, 'storyCreateFailed');
  assert.equal(record.entityId, null);
});
