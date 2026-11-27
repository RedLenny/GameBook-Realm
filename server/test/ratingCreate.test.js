import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createDiscoveryApp } from '../src/services/discovery/app.js';
import { createGameplayApp } from '../src/services/gameplay/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { createServiceClient } from '../src/shared/serviceClient.js';

// rating/create (Command createRating v Application Modelu): Petr dohraje „Ztracený důkaz“
// od autora Jana a dá mu 4 hvězdy.
const token = 'rating-create-test-service';
const sessionSecret = 'rating-create-test-session-secret';
const servers = [];
const clients = {};
let mongo, client, gateway;

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
const db = (name) => client.db('ratingCreate_' + name);
const cookie = (sub) => 'gr_session=' + jwt.sign({ sub }, sessionSecret, {
  algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
});
function rate(body, { as = 'petr' } = {}) {
  return fetch(gateway + '/api/discovery/rating/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(as && { cookie: cookie(as) }) },
    body: JSON.stringify(body),
  });
}
async function story({ state = 'published', authorId = 'jan' } = {}) {
  const now = new Date();
  const { insertedId } = await db('story').collection('stories').insertOne({
    name: 'Ztracený důkaz', description: 'Detektivka', genre: 'Detektivka', authorId, state,
    createdAt: now, updatedAt: now, publishedAt: state === 'published' ? now : null,
  });
  return insertedId.toHexString();
}
async function playthrough(storyId, { playerId = 'petr', state = 'finished' } = {}) {
  const now = new Date();
  const { insertedId } = await db('gameplay').collection('playthroughs').insertOne({
    storyId: new ObjectId(storyId), playerId, state, currentSceneId: new ObjectId(),
    decisionHistory: [], startedAt: now, updatedAt: now, finishedAt: state === 'finished' ? now : null,
  });
  return insertedId.toHexString();
}
const auditLog = () => db('audit').collection('auditLog');
async function expectError(res, status, code, details) {
  assert.equal(res.status, status);
  const error = await res.json();
  assert.equal(error.code, code);
  if (details) assert.deepEqual(error.details, details);
  return error;
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  await service('audit', createAuditApp);
  await service('story', createStoryApp);
  await service('gameplay', createGameplayApp);
  await service('discovery', createDiscoveryApp);
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

test('rating/create saves the rating of a finished playthrough and returns the new average', async () => {
  const storyId = await story();
  const earlier = await playthrough(storyId, { playerId: 'eva' });
  assert.equal((await rate({ playthroughId: earlier, stars: 5 }, { as: 'eva' })).status, 201);

  const playthroughId = await playthrough(storyId);
  const res = await rate({ playthroughId, stars: 4 });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.rating.id, /^[0-9a-f]{24}$/);
  assert.equal(body.rating.storyId, storyId);
  assert.equal(body.rating.stars, 4);
  assert.ok(!Number.isNaN(Date.parse(body.rating.createdAt)));
  assert.equal(body.averageRating, 4.5);
  assert.equal(body.ratingCount, 2);
  assert.deepEqual(body.uuAppErrorMap, {});

  const stored = await db('discovery').collection('ratings').findOne({ _id: new ObjectId(body.rating.id) });
  assert.equal(stored.playerId, 'petr');
  assert.equal(stored.playthroughId.toHexString(), playthroughId);

  const record = await auditLog().findOne({ entityId: body.rating.id });
  assert.equal(record.operation, 'rating/create');
  assert.equal(record.entityType, 'rating');
  assert.equal(record.storyId.toHexString(), storyId);
  assert.equal(record.actorId, 'petr');
  assert.equal(record.result, 'success');
  assert.deepEqual(record.detail, { stars: 4 });

});

test('rating/create allows one rating per player and story, even from another finished playthrough', async () => {
  const storyId = await story();
  assert.equal((await rate({ playthroughId: await playthrough(storyId), stars: 4 })).status, 201);
  const again = await rate({ playthroughId: await playthrough(storyId), stars: 1 });
  await expectError(again, 409, 'ratingAlreadyExists', { storyId });
  assert.equal(await db('discovery').collection('ratings').countDocuments({ storyId: new ObjectId(storyId) }), 1);
  const denied = await auditLog().findOne({ storyId: new ObjectId(storyId), result: 'denied' });
  assert.equal(denied.errorCode, 'ratingAlreadyExists');
});

test('rating/create rejects unknown, foreign and unfinished playthroughs', async () => {
  const storyId = await story();
  const missing = new ObjectId().toHexString();
  await expectError(await rate({ playthroughId: missing, stars: 4 }), 404, 'playthroughNotFound', { playthroughId: missing });

  const foreign = await playthrough(storyId, { playerId: 'eva' });
  const error = await expectError(await rate({ playthroughId: foreign, stars: 4 }), 403, 'userNotAuthorized',
    { playthroughId: foreign });
  assert.equal(error.error, 'Uživatel nemá oprávnění hodnotit tento příběh.');

  const unfinished = await playthrough(storyId, { state: 'inProgress' });
  await expectError(await rate({ playthroughId: unfinished, stars: 4 }), 409, 'playthroughNotFinished',
    { playthroughId: unfinished, state: 'inProgress' });

  const denied = await auditLog().find({ actorId: 'petr', result: 'denied', errorCode: 'playthroughNotFinished' }).toArray();
  assert.equal(denied.length, 1);
  assert.equal(await db('discovery').collection('ratings').countDocuments({ storyId: new ObjectId(storyId) }), 0);
});

test('rating/create forbids rating your own story and stories that are no longer published', async () => {
  const ownStory = await story({ authorId: 'jan' });
  const own = await playthrough(ownStory, { playerId: 'jan' });
  await expectError(await rate({ playthroughId: own, stars: 5 }, { as: 'jan' }), 403, 'ownStoryRatingForbidden',
    { storyId: ownStory });

  const draftStory = await story({ state: 'draft' });
  const draft = await playthrough(draftStory);
  await expectError(await rate({ playthroughId: draft, stars: 3 }), 409, 'storyNotPublished', { storyId: draftStory });

  const deletedStory = new ObjectId().toHexString();
  const deleted = await playthrough(deletedStory);
  await expectError(await rate({ playthroughId: deleted, stars: 3 }), 409, 'storyNotPublished', { storyId: deletedStory });
});

test('rating/create validates dtoIn and requires a signed-in user', async () => {
  const playthroughId = await playthrough(await story());
  const cases = [
    [{ stars: 4 }, 'playthroughId'],
    [{ playthroughId: 'abc', stars: 4 }, 'playthroughId'],
    [{ playthroughId }, 'stars'],
    [{ playthroughId, stars: 0 }, 'stars'],
    [{ playthroughId, stars: 6 }, 'stars'],
    [{ playthroughId, stars: 4.5 }, 'stars'],
    [{ playthroughId, stars: '4' }, 'stars'],
  ];
  for (const [body, key] of cases) {
    const error = await expectError(await rate(body), 400, 'invalidDtoIn');
    const maps = [error.details.missingKeyMap, error.details.invalidTypeKeyMap, error.details.invalidValueKeyMap];
    assert.ok(maps.some((map) => Object.hasOwn(map, key)), `${key}: ${JSON.stringify(body)}`);
  }
  await expectError(await rate({ playthroughId, stars: 4 }, { as: null }), 401, 'NOT_AUTHENTICATED');

  const extra = await rate({ playthroughId, stars: 4, comment: 'Skvělé!' });
  assert.equal(extra.status, 201);
  assert.deepEqual((await extra.json()).uuAppErrorMap.unsupportedKeys.unsupportedKeyList, ['comment']);
});

test('playthrough/getFinished is internal only', async () => {
  const playthroughId = await playthrough(await story());
  const path = '/api/playthroughs/playthrough/getFinished?id=' + playthroughId + '&playerId=petr';
  assert.equal((await fetch(gateway + path, { headers: { cookie: cookie('petr') } })).status, 404);
  const internal = '/internal/playthrough/getFinished?id=' + playthroughId + '&playerId=petr';
  const { playthrough: found } = await clients.gameplay.request(internal);
  assert.equal(found.id, playthroughId);
  assert.equal(found.state, 'finished');
});

test('rating/create reports ratingSaveFailed when Gameplay is unreachable', async () => {
  const offline = createServiceClient({ name: 'gameplay', url: 'http://127.0.0.1:9', token, timeoutMs: 500 });
  const url = await serve(createDiscoveryApp({ db: db('discovery'), token, clients: { ...clients, gameplay: offline } }));
  const original = console.error;
  console.error = () => {};
  try {
    const playthroughId = new ObjectId().toHexString();
    const res = await fetch(url + '/api/discovery/rating/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-token': token, 'x-player-id': 'petr' },
      body: JSON.stringify({ playthroughId, stars: 4 }),
    });
    await expectError(res, 503, 'ratingSaveFailed', { playthroughId });
  } finally {
    console.error = original;
  }
});
