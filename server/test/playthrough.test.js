import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { initDatabase } from '../src/db/init.js';
import { story as seedStory, scenes as seedScenes, AUTHOR_ID } from '../src/seed/ztracenyDukaz.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createGameplayApp } from '../src/services/gameplay/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { createServiceClient } from '../src/shared/serviceClient.js';

// playthrough/start (Command startPlaythrough): Petr najde „Ztracený důkaz“ od Jana a začne ho hrát.
const token = 'playthrough-test-service';
const sessionSecret = 'playthrough-test-session-secret';
const servers = [];
const clients = {};
const [s1001] = seedScenes;
let mongo, client, gateway, daos;

const db = (name) => client.db('playthrough_' + name);
async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function service(name, factory) {
  const url = await serve(factory({ db: db(name), token, clients }));
  clients[name] = createServiceClient({ name, url, token });
  return url;
}
const cookie = (sub) => 'gr_session=' + jwt.sign({ sub }, sessionSecret, {
  algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
});
const start = (body, { as = 'petr' } = {}) => fetch(gateway + '/api/playthroughs/start', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(as && { cookie: cookie(as) }) }, body: JSON.stringify(body),
});
async function expectError(res, status, code, details) {
  assert.equal(res.status, status);
  const error = await res.json();
  assert.equal(error.code, code);
  if (details) assert.deepEqual(error.details, details);
  return error;
}
async function started(storyId, as) {
  const res = await start({ storyId }, { as });
  assert.equal(res.status, 201);
  return res.json();
}
const auditLog = () => db('audit').collection('auditLog');
const playthroughs = () => db('gameplay').collection('playthroughs');

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  daos = await initDatabase(client, { seed: true, dbName: (name) => 'playthrough_' + name });
  await service('audit', createAuditApp);
  await service('story', createStoryApp);
  await service('gameplay', createGameplayApp);
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

// ---------- playthrough/start ----------

test('playthrough/start opens the initial scene without revealing where decisions lead', async () => {
  const res = await start({ storyId: seedStory.id });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.uuAppErrorMap, {});
  const { playthrough, currentScene, progress } = body;
  assert.match(playthrough.id, /^[0-9a-f]{24}$/);
  assert.equal(playthrough.storyId, seedStory.id);
  assert.equal(playthrough.storyName, 'Ztracený důkaz');
  assert.equal(playthrough.state, 'inProgress');
  assert.equal(playthrough.currentSceneId, s1001.id);
  assert.ok(playthrough.startedAt);
  assert.deepEqual(currentScene, {
    id: s1001.id, name: s1001.name, content: s1001.content, type: 'initial',
    decisionList: s1001.decisions.map(({ id, text }) => ({ id, text })),
  });
  assert.deepEqual(progress, { visitedSceneCount: 1, totalSceneCount: 6, percent: 17 });

  const stored = await playthroughs().findOne({ _id: new ObjectId(playthrough.id) });
  assert.equal(stored.playerId, 'petr');
  assert.deepEqual(stored.visitedSceneIds.map(String), [s1001.id]);
  const record = await auditLog().findOne({ operation: 'playthrough/start', entityId: playthrough.id });
  assert.equal(record.result, 'success');
  assert.equal(record.actorId, 'petr');
  assert.deepEqual(record.detail, { restart: false });
});

test('playthrough/start offers continue or restart; restart abandons the previous playthrough', async () => {
  const first = await started(seedStory.id, 'karel');
  await expectError(await start({ storyId: seedStory.id }, { as: 'karel' }),
    409, 'playthroughInProgress', { playthroughId: first.playthrough.id });

  const res = await start({ storyId: seedStory.id, restart: true }, { as: 'karel' });
  assert.equal(res.status, 201);
  const second = await res.json();
  assert.notEqual(second.playthrough.id, first.playthrough.id);
  const old = await playthroughs().findOne({ _id: new ObjectId(first.playthrough.id) });
  assert.equal(old.state, 'abandoned');
  const record = await auditLog().findOne({ operation: 'playthrough/start', entityId: second.playthrough.id });
  assert.deepEqual(record.detail, { restart: true, abandonedPlaythroughId: first.playthrough.id });
  assert.equal(await playthroughs().countDocuments({ playerId: 'karel', state: 'inProgress' }), 1);
});

test('one in-progress playthrough is per story: other stories can be played at the same time', async () => {
  const other = await daos.story.stories.create({ name: 'Poslední z Nagů', authorId: AUTHOR_ID });
  await daos.story.scenes.create({ storyId: other.id, name: 'Start', content: 'Text', type: 'initial' });
  await daos.story.stories.publish(other.id);
  await started(seedStory.id, 'hana');
  await started(other.id, 'hana');
  assert.equal(await playthroughs().countDocuments({ playerId: 'hana', state: 'inProgress' }), 2);
});

test('playthrough/start lets only one of two concurrent starts through', async () => {
  const results = await Promise.all([start({ storyId: seedStory.id }, { as: 'eva' }), start({ storyId: seedStory.id }, { as: 'eva' })]);
  assert.deepEqual(results.map((res) => res.status).sort(), [201, 409]);
  const winner = await results.find((res) => res.status === 201).json();
  await expectError(results.find((res) => res.status === 409), 409, 'playthroughInProgress', { playthroughId: winner.playthrough.id });
  assert.equal(await playthroughs().countDocuments({ playerId: 'eva', state: 'inProgress' }), 1);
});

test('playthrough/start lets the author play the own story', async () => {
  assert.equal((await start({ storyId: seedStory.id }, { as: AUTHOR_ID })).status, 201);
});

test('playthrough/start rejects unknown, unpublished and unplayable stories', async () => {
  const unknown = new ObjectId().toHexString();
  await expectError(await start({ storyId: unknown }), 404, 'storyNotFound', { storyId: unknown });

  const draft = await daos.story.stories.create({ name: 'Rozepsaný', authorId: AUTHOR_ID });
  await daos.story.scenes.create({ storyId: draft.id, name: 'Start', content: 'Text', type: 'initial' });
  await expectError(await start({ storyId: draft.id }), 409, 'storyNotPublished', { storyId: draft.id, state: 'draft' });

  const broken = await daos.story.stories.create({ name: 'Bez začátku', authorId: AUTHOR_ID });
  await daos.story.scenes.create({ storyId: broken.id, name: 'Konec', content: 'Text', type: 'final' });
  await daos.story.stories.publish(broken.id);
  await expectError(await start({ storyId: broken.id }), 409, 'initialSceneNotFound', { storyId: broken.id });

  const denied = await auditLog().countDocuments({ operation: 'playthrough/start', actorId: 'petr', result: 'denied' });
  assert.ok(denied >= 3);
  assert.equal(await playthroughs().countDocuments({ storyId: { $in: [new ObjectId(draft.id), new ObjectId(broken.id)] } }), 0);
});

test('playthrough/start validates dtoIn and requires a session', async () => {
  await expectError(await start({ storyId: 'abc' }), 400, 'invalidDtoIn');
  await expectError(await start({ storyId: seedStory.id, restart: 'yes' }), 400, 'invalidDtoIn');
  await expectError(await start({}), 400, 'invalidDtoIn');
  await expectError(await start({ storyId: seedStory.id }, { as: null }), 401, 'NOT_AUTHENTICATED');
});

test('Story Service outage maps to sceneLoadFailed', async () => {
  const deadStory = createServiceClient({ name: 'story', url: 'http://127.0.0.1:1', token, timeoutMs: 500 });
  const gameplayUrl = await serve(createGameplayApp({ db: db('gameplay'), token, clients: { story: deadStory, audit: clients.audit } }));
  const original = console.error;
  console.error = () => {};
  try {
    const res = await fetch(gameplayUrl + '/api/playthroughs/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': token, 'x-player-id': 'outage' },
      body: JSON.stringify({ storyId: seedStory.id }),
    });
    await expectError(res, 503, 'sceneLoadFailed', { storyId: seedStory.id });
  } finally {
    console.error = original;
  }
  const record = await auditLog().findOne({ operation: 'playthrough/start', actorId: 'outage', result: 'error' });
  assert.equal(record.errorCode, 'sceneLoadFailed');
  assert.equal(await playthroughs().countDocuments({ playerId: 'outage' }), 0);
});
