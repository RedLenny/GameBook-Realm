import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';
import { createAuthRouter } from '../src/gateway/googleAuth.js';
import { initDatabase, seedDatabase } from '../src/db/init.js';
import { createAuditApp } from '../src/services/audit/app.js';
import { createDiscoveryApp } from '../src/services/discovery/app.js';
import { createGameplayApp } from '../src/services/gameplay/app.js';
import { createStoryApp } from '../src/services/story/app.js';
import { syncPublishedIndex } from '../src/services/discovery/syncIndex.js';
import { createServiceClient } from '../src/shared/serviceClient.js';
import { createAuditClient } from '../src/shared/auditClient.js';
import { scenes, story } from '../src/seed/ztracenyDukaz.js';

const token = 'week2-test-service';
const sessionSecret = 'isolated-gateway-session-secret-for-tests';
const servers = [];
const clients = {};
let mongo, client, daos, gateway, audit;
const id = () => new ObjectId().toHexString();

async function serve(app) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function service(name, factory) {
  const url = await serve(factory({ db: client.db('week2_' + name), token, clients }));
  clients[name] = createServiceClient({ name, url, token });
  return url;
}
function session(player, secret = sessionSecret) {
  return { cookie: 'gr_session=' + jwt.sign({ sub: player }, secret, {
    algorithm: 'HS256', issuer: 'gamebook-realm-gateway', expiresIn: '5m',
  }) };
}
const post = (body) => ({ method: 'POST', body });
const statsPath = (storyId) => '/api/discovery/rating/getStats?storyId=' + storyId;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  daos = await initDatabase(client, { seed: true, dbName: (name) => 'week2_' + name });
  audit = await service('audit', createAuditApp);
  await service('story', createStoryApp);
  await service('discovery', createDiscoveryApp);
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

test('audit/create persists the domain fields and trace once across concurrent retries', async () => {
  const record = {
    id: id(), actorId: 'writer', actorName: 'Jan', actorProfiles: ['Users'], operation: 'story/publish',
    entityType: 'story', entityId: story.id, storyId: story.id, result: 'denied',
    errorCode: 'publishCheckFailed', detail: { errorCount: 2, _id: 'preserve this JSON key' },
  };
  const path = '/internal/audit/create';
  const results = await Promise.all([1, 2].map(() => clients.audit.send(path, {
    ...post(record), requestId: 'original-trace',
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const stored = await client.db('week2_audit').collection('auditLog').findOne();
  assert.equal(stored.requestId, 'original-trace');
  assert.equal(stored.storyId.toHexString(), story.id);
  assert.deepEqual(stored.detail, record.detail);
  assert.ok(stored.at instanceof Date);
  const api = createAuditClient(clients.audit, 'story');
  const retry = await api.create(record, { requestId: 'second-trace' });
  assert.deepEqual(retry, results[0].data);
  await assert.rejects(api.create({ ...record, result: 'success' }), { code: 'auditIdConflict' });
  await assert.rejects(api.create({ ...record, detail: { text: '🟢'.repeat(512) } }), { code: 'invalidDtoIn' });
  assert.equal(await client.db('week2_audit').collection('auditLog').countDocuments(), 1);
  assert.equal((await fetch(audit + path, { method: 'POST' })).status, 401);
  assert.equal((await fetch(gateway + path, { method: 'POST' })).status, 404);
});

test('index notifications read canonical Story metadata, hide drafts and survive retries or deletion', async () => {
  const draft = await daos.story.stories.create({ name: 'Island [A]', genre: 'Fantasy', authorId: 'jan' });
  const command = (action) => clients.discovery.request('/internal/storyIndex/' + action, post({ storyId: draft.id }));
  await assert.rejects(command('create'), { code: 'storyNotPublished' });
  await assert.rejects(command('delete'), { code: 'storyStillExists' });
  await daos.story.stories.publish(draft.id);
  await Promise.all([command('create'), command('create')]);
  const list = () => clients.discovery.request('/internal/storyIndex/list?name=%5Ba%5D&genre=Fantasy');
  const first = await list();
  assert.deepEqual(first.itemList.map((s) => s.id), [draft.id]);
  assert.equal(first.itemList[0].averageRating, null);
  assert.equal(first.pageInfo.total, 1);
  await daos.story.stories.delete(draft.id);
  await command('delete');
  await command('delete');
  // An older scan had already read this publication when it was deleted.
  await daos.discovery.storyIndex.put(first.itemList[0]);
  assert.deepEqual((await list()).itemList, []);
  assert.equal((await fetch(gateway + statsPath(draft.id), { headers: session('a') })).status, 404);
});

test('catalogue and signed-in stats reader use saved ratings, including the zero and rounded cases', async () => {
  const get = async () => {
    const res = await fetch(gateway + statsPath(story.id), { headers: session('reader') });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.equal((await get()).averageRating, null);
  assert.equal((await get()).ratingCount, 0);
  for (const [i, value] of [5, 4, 2].entries()) {
    await daos.discovery.ratings.create({ storyId: story.id, playerId: 'r' + i, playthroughId: id(), value });
  }
  await assert.rejects(daos.discovery.ratings.create({
    storyId: story.id, playerId: 'r0', playthroughId: id(), value: 1,
  }));
  const result = await get();
  assert.equal(result.averageRating, 3.7);
  assert.equal(result.ratingCount, 3);
  const { itemList } = await clients.discovery.request('/internal/storyIndex/list?name=Ztracen');
  assert.equal(itemList[0].ratingCount, result.ratingCount);
  assert.equal(itemList[0].averageRating, result.averageRating);
  await daos.discovery.ratings.collection.insertOne({
    storyId: new ObjectId(story.id), playthroughId: new ObjectId(), playerId: 'r3', stars: 1,
  });
  const updated = await clients.discovery.request('/internal/storyIndex/updateRating', post({
    storyId: story.id, averageRating: result.averageRating, ratingCount: result.ratingCount,
  }));
  assert.equal(updated.averageRating, 3);
  assert.equal(updated.ratingCount, 4);
  assert.deepEqual(await get(), updated);
  assert.equal((await fetch(gateway + statsPath(story.id))).status, 401);
});

test('explicit reseeding restores the fixed sample story in the catalogue after its deletion', async () => {
  await daos.story.stories.delete(story.id);
  await clients.discovery.request('/internal/storyIndex/delete', post({ storyId: story.id }));
  assert.equal(await daos.discovery.storyIndex.getRatingStats(story.id), null);
  await seedDatabase(daos);
  const { items } = await daos.discovery.storyIndex.listPublished({ name: story.name });
  assert.deepEqual(items.map((item) => item.id), [story.id]);
});

test('reconciliation backfills multiple pages and removes a missed deletion; upstream failure is not a deletion', async () => {
  const db = client.db('week2_story');
  const extra = Array.from({ length: 105 }, (_, i) => ({
    _id: new ObjectId(), name: 'Batch ' + i, state: 'published', publishedAt: new Date(), authorId: 'jan',
  }));
  await db.collection('stories').insertMany(extra);
  const index = daos.discovery.storyIndex;
  await syncPublishedIndex(index, clients.story);
  assert.equal((await index.listPublished({ name: 'Batch' })).total, 105);
  await db.collection('stories').deleteOne({ _id: extra[0]._id });
  await assert.rejects(syncPublishedIndex(index, { request: async () => ({ error: 'upstream failed' }) }));
  assert.equal((await index.listPublished({ name: 'Batch' })).total, 105);
  await syncPublishedIndex(index, clients.story);
  assert.equal((await index.listPublished({ name: 'Batch' })).total, 104);
});

test('playthrough/list scopes paging to the signed player and combines distinct scenes across their attempts', async () => {
  const pt = daos.gameplay.playthroughs;
  const create = (playerId) => pt.create({ storyId: story.id, initialSceneId: scenes[0].id, playerId });
  const choose = (run, sceneIndex, choiceIndex, finished = false) => {
    const scene = scenes[sceneIndex];
    const choice = scene.decisions[choiceIndex];
    return pt.recordDecision(run.id, { sceneId: scene.id, decisionId: choice.id, targetSceneId: choice.targetSceneId, finished });
  };
  const finished = await create('martin');
  await choose(finished, 0, 1);
  await choose(finished, 2, 0, true);
  const abandoned = await create('martin');
  await choose(abandoned, 0, 0);
  await choose(abandoned, 1, 0);
  await pt.collection.updateOne({ _id: new ObjectId(abandoned.id) }, {
    $set: { state: 'abandoned', visitedSceneIds: [0, 1, 3].map((i) => new ObjectId(scenes[i].id)) },
  });
  const active = await create('martin');
  await choose(active, 0, 0);
  const otherStory = await daos.story.stories.create({ name: 'Second game', authorId: 'jan' });
  const otherScene = await daos.story.scenes.create({ storyId: otherStory.id, name: 'Opening', type: 'initial' });
  await daos.story.stories.publish(otherStory.id);
  const older = await pt.create({ storyId: otherStory.id, initialSceneId: otherScene.id, playerId: 'martin' }, { now: new Date(0) });
  const otherPlayer = await create('another-player');
  await choose(otherPlayer, 0, 1);
  await choose(otherPlayer, 2, 1, true);
  const url = gateway + '/api/playthroughs/list';
  const headers = { ...session('martin'), 'x-player-id': 'another-player' };
  const get = async (query = '') => {
    const res = await fetch(url + query, { headers });
    assert.equal(res.status, 200);
    return res.json();
  };
  const own = await get('?pageInfo[pageSize]=1&playerId=another-player');
  assert.deepEqual(own.pageInfo, { pageIndex: 0, pageSize: 1, total: 2 });
  assert.deepEqual(own.itemList.map((r) => r.id), [active.id]);
  assert.deepEqual(own.uuAppErrorMap.unsupportedKeys.unsupportedKeyList, ['playerId']);
  assert.equal(own.itemList[0].storyName, story.name);
  assert.equal(own.itemList[0].progressPercent, 83);
  assert.deepEqual((await get('?pageIndex=1&pageSize=1')).itemList.map((r) => r.id), [older.id]);
  assert.deepEqual((await get('?state=finished')).itemList.map((r) => r.id), [finished.id]);
  const empty = await fetch(url, { headers: session('new-player') });
  assert.deepEqual((await empty.json()).itemList, []);
  assert.equal((await fetch(url + '?state=abandoned', { headers })).status, 400);
  assert.equal((await fetch(url + '?pageSize=0', { headers })).status, 400);
  assert.equal((await fetch(url, { headers: { 'x-player-id': 'martin' } })).status, 401);
  assert.equal((await fetch(url, { headers: session('martin', 'wrong-signature') })).status, 401);
});

test('saved games survive a fresh gateway login and follow the Google account across an email change', async () => {
  const config = {
    clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost/callback',
    frontendUrl: 'http://frontend.test', sessionSecret,
  };
  async function freshGateway() {
    const google = new OAuth2Client(config);
    google.getToken = async () => ({ tokens: { id_token: 'test-token' } });
    const authRouter = createAuthRouter({ clients, config, oauthClient: google });
    const base = await serve(createApp({ clients, sessionConfig: config, authRouter }));
    return async (sub, email) => {
      const start = await fetch(base + '/api/auth/google', { redirect: 'manual' });
      const { searchParams } = new URL(start.headers.get('location'));
      google.verifyIdToken = async () => ({
        getPayload: () => ({ sub, email, email_verified: true, name: 'Test Player', nonce: searchParams.get('nonce') }),
      });
      const callback = await fetch(base + '/api/auth/google/callback?code=test&state=' + searchParams.get('state'), {
        redirect: 'manual', headers: { cookie: start.headers.getSetCookie()[0].split(';')[0] },
      });
      assert.equal(callback.headers.get('location'), config.frontendUrl);
      const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith('gr_session='));
      const get = async (path) => {
        const res = await fetch(base + path, { headers: { cookie: session.split(';')[0] } });
        assert.equal(res.status, 200);
        return res.json();
      };
      return get;
    };
  }
  const signIn = await freshGateway();
  const first = await signIn('google-player-42', 'old@example.test');
  const { id: playerId } = await first('/api/auth/me');
  const game = await daos.gameplay.playthroughs.create({ storyId: story.id, initialSceneId: scenes[0].id, playerId });
  const signInAgain = await freshGateway();
  const returning = await signInAgain('google-player-42', 'new@example.test');
  assert.deepEqual((await returning('/api/playthroughs/list')).itemList.map((item) => item.id), [game.id]);
  const different = await signInAgain('google-player-43', 'new@example.test');
  assert.deepEqual((await different('/api/playthroughs/list')).itemList, []);
});
