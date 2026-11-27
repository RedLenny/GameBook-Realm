import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { createStoryDao } from '../src/services/story/dao/storyDao.js';
import { createServiceClient } from '../src/shared/serviceClient.js';

// scene/create (Command addScene v Application Modelu): Jan přidává scény do „Ztraceného důkazu“.
const token = 'scene-create-test-service';
const sessionSecret = 'scene-create-test-session-secret';
const servers = [];
const clients = {};
let mongo, client, gateway, stories;

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function service(name, factory) {
  const url = await serve(factory({ db: client.db('sceneCreate_' + name), token, clients }));
  clients[name] = createServiceClient({ name, url, token });
  return url;
}
const cookie = (sub) => 'gr_session=' + jwt.sign({ sub }, sessionSecret, {
  algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
});
function addScene(body, { as = 'jan' } = {}) {
  return fetch(gateway + '/api/stories/scene/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as && { cookie: cookie(as) }) },
    body: JSON.stringify(body),
  });
}
const draft = () => stories.create({ name: 'Ztracený důkaz', genre: 'Detektivka', authorId: 'jan' });
const scene = (storyId, overrides = {}) => ({
  storyId, name: 'Rozhovor v kavárně', content: 'Číšník je nervózní a vyhýbá se odpovědím na vaše otázky.',
  type: 'regular', ...overrides,
});
const auditLog = () => client.db('sceneCreate_audit').collection('auditLog');

// Služba s podvrženou databází pro chyby, které skutečná MongoDB nevyvolá na požádání.
async function storyWithDb({ story, scenes }) {
  return serve(createStoryApp({
    db: { collection: (name) => (name === 'stories' ? story : scenes) }, token, clients,
  }));
}
async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}
const direct = (url, body) => fetch(url + '/api/stories/scene/create', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-service-token': token, 'x-player-id': 'jan' },
  body: JSON.stringify(body),
});

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  stories = createStoryDao(client.db('sceneCreate_story'));
  await service('audit', createAuditApp);
  await service('story', createStoryApp);
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

test('scene/create adds a scene to the author\'s draft and audits it', async () => {
  const story = await draft();
  const res = await addScene(scene(story.id, { name: '  Rozhovor v kavárně ' }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.uuAppErrorMap, {});
  const { scene: created } = body;
  assert.match(created.id, /^[0-9a-f]{24}$/);
  assert.equal(created.storyId, story.id);
  assert.equal(created.name, 'Rozhovor v kavárně');
  assert.equal(created.content, 'Číšník je nervózní a vyhýbá se odpovědím na vaše otázky.');
  assert.equal(created.type, 'regular');
  assert.deepEqual(created.decisions, []);
  assert.equal(created.createdAt, created.updatedAt);

  const stored = await client.db('sceneCreate_story').collection('scenes').findOne({ _id: new ObjectId(created.id) });
  assert.equal(stored.storyId.toHexString(), story.id);

  const record = await auditLog().findOne({ entityId: created.id });
  assert.equal(record.operation, 'scene/create');
  assert.equal(record.entityType, 'scene');
  assert.equal(record.storyId.toHexString(), story.id);
  assert.equal(record.actorId, 'jan');
  assert.equal(record.result, 'success');
  assert.deepEqual(record.detail, { name: 'Rozhovor v kavárně', type: 'regular' });
});

test('scene/create allows only one initial scene but any number of final scenes', async () => {
  const story = await draft();
  const first = await addScene(scene(story.id, { name: 'Příchod do kavárny', type: 'initial' }));
  assert.equal(first.status, 201);
  const initialId = (await first.json()).scene.id;

  const second = await addScene(scene(story.id, { name: 'Jiný začátek', type: 'initial' }));
  assert.equal(second.status, 409);
  const error = await second.json();
  assert.equal(error.code, 'initialSceneAlreadyExists');
  assert.deepEqual(error.details, { storyId: story.id, existingSceneId: initialId });

  for (const name of ['Nahlášení na inspektorát', 'Odvoz do nemocnice']) {
    assert.equal((await addScene(scene(story.id, { name, type: 'final' }))).status, 201);
  }
  const record = await auditLog().findOne({ storyId: new ObjectId(story.id), result: 'denied' });
  assert.equal(record.errorCode, 'initialSceneAlreadyExists');
  assert.equal(record.entityId, null);
});

test('scene/create rejects other users, published stories and unknown stories', async () => {
  const story = await draft();
  const foreign = await addScene(scene(story.id), { as: 'petr' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json().then((e) => [e.code, e.details]), ['userNotAuthorized', { storyId: story.id }]);
  const denied = await auditLog().findOne({ storyId: new ObjectId(story.id), actorId: 'petr' });
  assert.equal(denied.result, 'denied');
  assert.equal(denied.errorCode, 'userNotAuthorized');

  const { insertedId } = await client.db('sceneCreate_story').collection('stories').insertOne({
    name: 'Hotový příběh', description: '', genre: null, authorId: 'jan', state: 'published',
    createdAt: new Date(), updatedAt: new Date(), publishedAt: new Date(),
  });
  const published = await addScene(scene(insertedId.toHexString()));
  assert.equal(published.status, 409);
  const publishedError = await published.json();
  assert.equal(publishedError.code, 'storyNotEditable');
  assert.deepEqual(publishedError.details, { storyId: insertedId.toHexString(), state: 'published' });

  const missingId = new ObjectId().toHexString();
  const missing = await addScene(scene(missingId));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json().then((e) => [e.code, e.details]), ['storyNotFound', { storyId: missingId }]);

  const scenes = await client.db('sceneCreate_story').collection('scenes').countDocuments({ storyId: new ObjectId(story.id) });
  assert.equal(scenes, 0);
});

test('scene/create validates dtoIn and warns about unsupported keys', async () => {
  const story = await draft();
  const cases = [
    [{ name: 'A', content: 'B', type: 'regular' }, 'missingKeyMap', 'storyId'],
    [scene('not-an-id'), 'invalidValueKeyMap', 'storyId'],
    [scene(story.id, { name: '   ' }), 'invalidValueKeyMap', 'name'],
    [scene(story.id, { name: 'x'.repeat(121) }), 'invalidValueKeyMap', 'name'],
    [scene(story.id, { content: ' \n\t ' }), 'invalidValueKeyMap', 'content'],
    [scene(story.id, { content: 'x'.repeat(10001) }), 'invalidValueKeyMap', 'content'],
    [scene(story.id, { type: 'ending' }), 'invalidValueKeyMap', 'type'],
    [scene(story.id, { type: undefined }), 'missingKeyMap', 'type'],
  ];
  for (const [body, map, key] of cases) {
    const res = await addScene(body);
    assert.equal(res.status, 400, `${key}: ${JSON.stringify(body).slice(0, 80)}`);
    const error = await res.json();
    assert.equal(error.code, 'invalidDtoIn');
    assert.ok(Object.hasOwn(error.details[map], key), `${key} in ${map}`);
  }

  const res = await addScene({ ...scene(story.id), decisions: [{ text: 'x' }], storyName: 'y' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.scene.decisions, []);
  assert.deepEqual(body.uuAppErrorMap.unsupportedKeys.unsupportedKeyList.sort(), ['decisions', 'storyName']);
});

test('scene/create requires a signed-in user', async () => {
  const story = await draft();
  const res = await addScene(scene(story.id), { as: null });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'NOT_AUTHENTICATED');
});

test('scene/create reports a concurrent second initial scene caught by the unique index', async () => {
  const storyId = new ObjectId();
  const existingId = new ObjectId();
  let initialLookups = 0;
  const url = await storyWithDb({
    story: { findOne: async () => ({ _id: storyId, authorId: 'jan', state: 'draft', name: 'Ztracený důkaz' }) },
    scenes: {
      // První kontrola úvodní scénu nenajde, mezitím ji ale vložil jiný požadavek.
      findOne: async () => (initialLookups++ === 0 ? null : { _id: existingId, storyId, type: 'initial' }),
      insertOne: async () => { throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); },
    },
  });
  const res = await direct(url, scene(storyId.toHexString(), { type: 'initial' }));
  assert.equal(res.status, 409);
  const error = await res.json();
  assert.equal(error.code, 'initialSceneAlreadyExists');
  assert.equal(error.details.existingSceneId, existingId.toHexString());
});

test('scene/create maps database failures to storyLoadFailed and sceneCreateFailed', async () => {
  const storyId = new ObjectId();
  const down = async () => { throw new Error('db down'); };
  const loadUrl = await storyWithDb({ story: { findOne: down }, scenes: {} });
  const load = await quietly(() => direct(loadUrl, scene(storyId.toHexString())));
  assert.equal(load.status, 500);
  assert.equal((await load.json()).code, 'storyLoadFailed');

  const createUrl = await storyWithDb({
    story: { findOne: async () => ({ _id: storyId, authorId: 'jan', state: 'draft' }) },
    scenes: { findOne: async () => null, insertOne: down },
  });
  const created = await quietly(() => direct(createUrl, scene(storyId.toHexString())));
  assert.equal(created.status, 500);
  assert.equal((await created.json()).code, 'sceneCreateFailed');

  const errors = await auditLog().countDocuments({ storyId, result: 'error' });
  assert.equal(errors, 2);
});
