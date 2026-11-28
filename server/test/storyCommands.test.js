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
import { createStoryApp } from '../src/services/story/app.js';
import { sceneLimits } from '../src/services/story/limits.js';
import { createServiceClient } from '../src/shared/serviceClient.js';

// decision/create (Command addDecision), story/get, story/list a interní story/getPlayable.
// Jan (autor seedu „Ztracený důkaz“) píše příběh, Petr je hráč.
const token = 'story-commands-test-service';
const sessionSecret = 'story-commands-test-session-secret';
const servers = [];
const clients = {};
const JAN = AUTHOR_ID;
const PETR = 'petr';
let mongo, client, gateway, storyUrl, daos;

const db = (name) => client.db('storyCmd_' + name);
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
function call(path, { body, query, as = JAN } = {}) {
  const url = gateway + '/api/stories' + path + (query ? '?' + new URLSearchParams(query) : '');
  return fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body && { 'content-type': 'application/json' }), ...(as && { cookie: cookie(as) }) },
    ...(body && { body: JSON.stringify(body) }),
  });
}
const addDecision = (body, options) => call('/decision/create', { body, ...options });
async function expectError(res, status, code, details) {
  assert.equal(res.status, status);
  const error = await res.json();
  assert.equal(error.code, code);
  if (details) assert.deepEqual(error.details, details);
  return error;
}
const auditLog = () => db('audit').collection('auditLog');

// Koncept Jana se scénami podle potřeby testu.
async function draft({ authorId = JAN, name = 'Ztracený důkaz' } = {}) {
  return daos.story.stories.create({ name, genre: 'Detektivka', authorId });
}
const addScene = (storyId, name, type = 'regular') => daos.story.scenes.create({
  storyId, name, content: `Text scény ${name}.`, type,
});

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  daos = await initDatabase(client, { seed: true, dbName: (name) => 'storyCmd_' + name });
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

// ---------- decision/create ----------

test('decision/create links two scenes of the author\'s draft and audits it', async () => {
  const story = await draft();
  const cafe = await addScene(story.id, 'Rozhovor v kavárně');
  const kitchen = await addScene(story.id, 'Prohlídka kuchyně');

  const res = await addDecision({ sceneId: cafe.id, text: '  Nenápadně nahlédnout do kuchyně ', targetSceneId: kitchen.id });
  assert.equal(res.status, 201);
  const { scene, uuAppErrorMap } = await res.json();
  assert.deepEqual(uuAppErrorMap, {});
  assert.equal(scene.id, cafe.id);
  assert.equal(scene.decisions.length, 1);
  const [decision] = scene.decisions;
  assert.match(decision.id, /^[0-9a-f]{24}$/);
  assert.equal(decision.text, 'Nenápadně nahlédnout do kuchyně');
  assert.equal(decision.targetSceneId, kitchen.id);
  assert.ok(new Date(scene.updatedAt) >= new Date(cafe.updatedAt));

  const stored = await daos.story.scenes.get(cafe.id);
  assert.deepEqual(stored.decisions, scene.decisions);
  const record = await auditLog().findOne({ operation: 'decision/create', entityId: decision.id });
  assert.equal(record.result, 'success');
  assert.equal(record.entityType, 'decision');
  assert.equal(record.actorId, JAN);
  assert.equal(record.storyId.toHexString(), story.id);
  assert.deepEqual(record.detail, { sceneId: cafe.id, targetSceneId: kitchen.id });
});

test('decision/create enforces the story structure rules', async () => {
  const story = await draft();
  const start = await addScene(story.id, 'Příchod', 'initial');
  const end = await addScene(story.id, 'Konec', 'final');
  const other = await addScene((await draft({ name: 'Jiný příběh' })).id, 'Cizí scéna');
  const missing = new ObjectId().toHexString();
  const text = 'Pokračovat';

  await expectError(await addDecision({ sceneId: end.id, text, targetSceneId: start.id }),
    409, 'finalSceneDecisionForbidden', { sceneId: end.id, type: 'final' });
  await expectError(await addDecision({ sceneId: start.id, text, targetSceneId: start.id }),
    400, 'targetSceneSameAsSource', { sceneId: start.id, targetSceneId: start.id });
  await expectError(await addDecision({ sceneId: start.id, text, targetSceneId: other.id }),
    400, 'targetSceneDifferentStory', { sceneId: start.id, targetSceneId: other.id });
  await expectError(await addDecision({ sceneId: start.id, text, targetSceneId: missing }),
    404, 'targetSceneNotFound', { targetSceneId: missing });
  await expectError(await addDecision({ sceneId: missing, text, targetSceneId: start.id }),
    404, 'sceneNotFound', { sceneId: missing });
  assert.deepEqual((await daos.story.scenes.get(start.id)).decisions, []);

  // Rozhodnutí do koncové scény je v pořádku.
  assert.equal((await addDecision({ sceneId: start.id, text, targetSceneId: end.id })).status, 201);
  const denied = await auditLog().countDocuments({ operation: 'decision/create', storyId: new ObjectId(story.id), result: 'denied' });
  assert.equal(denied, 4, 'každé zamítnutí s nalezenou scénou má záznam v audit logu');
});

test('decision/create allows only the author and only in a draft', async () => {
  const story = await draft();
  const a = await addScene(story.id, 'A');
  const b = await addScene(story.id, 'B');
  const body = { sceneId: a.id, text: 'Dál', targetSceneId: b.id };

  await expectError(await addDecision(body, { as: PETR }), 403, 'userNotAuthorized', { sceneId: a.id });
  await daos.story.stories.publish(story.id);
  await expectError(await addDecision(body), 409, 'storyNotEditable', { storyId: story.id, state: 'published' });
  assert.deepEqual((await daos.story.scenes.get(a.id)).decisions, []);
});

test('decision/create keeps at most 20 decisions per scene, also under concurrent requests', async () => {
  const story = await draft();
  const source = await addScene(story.id, 'Rozcestí');
  const target = await addScene(story.id, 'Cíl');
  const max = sceneLimits.maxDecisionsPerScene;
  for (let i = 0; i < max - 1; i++) {
    await daos.story.scenes.addDecision(source.id, { text: 'Volba ' + i, targetSceneId: target.id });
  }
  const body = (text) => ({ sceneId: source.id, text, targetSceneId: target.id });
  const results = await Promise.all([addDecision(body('Souběžná 1')), addDecision(body('Souběžná 2'))]);
  const statuses = results.map((res) => res.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const rejected = results.find((res) => res.status === 409);
  await expectError(rejected, 409, 'decisionLimitExceeded', { sceneId: source.id, maxDecisionsPerScene: max });
  assert.equal((await daos.story.scenes.get(source.id)).decisions.length, max);
});

test('decision/create validates dtoIn, warns about unsupported keys and requires a session', async () => {
  const story = await draft();
  const a = await addScene(story.id, 'A');
  const b = await addScene(story.id, 'B');

  const blank = await expectError(await addDecision({ sceneId: a.id, text: '   ', targetSceneId: b.id }), 400, 'invalidDtoIn');
  assert.ok(blank.details.invalidValueKeyMap.text);
  const missing = await expectError(await addDecision({ sceneId: a.id }), 400, 'invalidDtoIn');
  assert.deepEqual(Object.keys(missing.details.missingKeyMap).sort(), ['targetSceneId', 'text']);
  await expectError(await addDecision({ sceneId: a.id, text: 'x'.repeat(256), targetSceneId: b.id }), 400, 'invalidDtoIn');

  const res = await addDecision({ sceneId: a.id, text: 'Dál', targetSceneId: b.id, color: 'red' });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).uuAppErrorMap, { unsupportedKeys: { unsupportedKeyList: ['color'] } });

  await expectError(await addDecision({ sceneId: a.id, text: 'Dál', targetSceneId: b.id }, { as: null }), 401, 'NOT_AUTHENTICATED');
});

// ---------- story/get ----------

test('story/get returns the draft with its scenes only to the author', async () => {
  const story = await draft();
  const a = await addScene(story.id, 'A', 'initial');
  const b = await addScene(story.id, 'B', 'final');
  await daos.story.scenes.addDecision(a.id, { text: 'Do B', targetSceneId: b.id });

  const res = await call('/story/get', { query: { id: story.id } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const body = await res.json();
  assert.equal(body.story.id, story.id);
  assert.equal(body.story.state, 'draft');
  assert.equal(body.story.sceneCount, 2);
  assert.deepEqual(body.sceneList.map((scene) => [scene.name, scene.type, scene.decisions.length]), [['A', 'initial', 1], ['B', 'final', 0]]);
  assert.equal(body.sceneList[0].decisions[0].targetSceneId, b.id);

  // Cizí koncept se tváří jako neexistující.
  await expectError(await call('/story/get', { query: { id: story.id }, as: PETR }), 404, 'storyNotFound', { storyId: story.id });
});

test('story/get shows a published story to any player without spoiling its scenes', async () => {
  const res = await call('/story/get', { query: { id: seedStory.id }, as: PETR });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.story.name, 'Ztracený důkaz');
  assert.equal(body.story.state, 'published');
  assert.equal(body.story.sceneCount, seedScenes.length);
  assert.equal(body.sceneList, undefined);

  const own = await (await call('/story/get', { query: { id: seedStory.id } })).json();
  assert.equal(own.sceneList.length, seedScenes.length);

  const unknown = new ObjectId().toHexString();
  await expectError(await call('/story/get', { query: { id: unknown } }), 404, 'storyNotFound');
  await expectError(await call('/story/get', { query: { id: 'abc' } }), 400, 'invalidDtoIn');
  await expectError(await call('/story/get', { query: { id: seedStory.id }, as: null }), 401, 'NOT_AUTHENTICATED');
});

// ---------- story/list ----------

test('story/list returns only the caller\'s stories, newest first, with scene counts and paging', async () => {
  const author = 'eva';
  const first = await draft({ authorId: author, name: 'První' });
  const second = await draft({ authorId: author, name: 'Druhý' });
  await addScene(second.id, 'Jediná scéna', 'initial');
  await daos.story.stories.update(first.id, { description: 'Upraveno později' });
  await draft({ authorId: 'someone-else', name: 'Cizí' });

  const res = await call('/story/list', { as: author });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.itemList.map((story) => [story.name, story.sceneCount]), [['První', 0], ['Druhý', 1]]);
  assert.deepEqual(body.pageInfo, { pageIndex: 0, pageSize: 20, total: 2 });
  assert.deepEqual(body.uuAppErrorMap, {});

  const page = await (await call('/story/list', { as: author, query: { 'pageInfo[pageIndex]': 1, 'pageInfo[pageSize]': 1 } })).json();
  assert.deepEqual(page.itemList.map((story) => story.name), ['Druhý']);
  assert.deepEqual(page.pageInfo, { pageIndex: 1, pageSize: 1, total: 2 });

  await daos.story.stories.publish(second.id);
  const published = await (await call('/story/list', { as: author, query: { state: 'published' } })).json();
  assert.deepEqual(published.itemList.map((story) => story.name), ['Druhý']);

  await expectError(await call('/story/list', { as: author, query: { state: 'deleted' } }), 400, 'invalidDtoIn');
  await expectError(await call('/story/list', { as: author, query: { pageSize: 101 } }), 400, 'invalidDtoIn');
  await expectError(await call('/story/list', { as: null }), 401, 'NOT_AUTHENTICATED');
});

// ---------- story/getPlayable (interní) ----------

const internal = (query, headers = { 'x-service-token': token }) =>
  fetch(storyUrl + '/internal/story/getPlayable?' + new URLSearchParams(query), { headers });

test('story/getPlayable returns the scene count and the initial scene without decision targets', async () => {
  const res = await internal({ id: seedStory.id });
  assert.equal(res.status, 200);
  const [initial] = seedScenes;
  assert.deepEqual(await res.json(), {
    story: { id: seedStory.id, name: seedStory.name, state: 'published' },
    sceneCount: seedScenes.length,
    initialScene: {
      id: initial.id, name: initial.name, content: initial.content, type: 'initial',
      decisions: initial.decisions.map(({ id, text }) => ({ id, text })),
    },
  });
});

test('story/getPlayable hides draft content, reports unknown stories and is internal only', async () => {
  const story = await draft();
  await addScene(story.id, 'Tajná scéna', 'initial');
  const body = await (await internal({ id: story.id })).json();
  assert.deepEqual(body, { story: { id: story.id, name: story.name, state: 'draft' } });

  const unknown = new ObjectId().toHexString();
  await expectError(await internal({ id: unknown }), 404, 'storyNotFound', { storyId: unknown });
  assert.equal((await internal({ id: story.id }, {})).status, 401);
  assert.equal((await fetch(gateway + '/internal/story/getPlayable?id=' + story.id)).status, 404);
});

const removeScene = (sceneId, as) => call('/scene/delete', { body: { sceneId }, as });

test('scene/delete protects the initial and referenced scenes and deletes an unreferenced draft scene', async () => {
  const { id: storyId } = await draft();
  const start = await addScene(storyId, 'Začátek', 'initial');
  const ending = await addScene(storyId, 'Výsledek', 'final');
  const extra = await addScene(storyId, 'Scéna navíc');
  const { decision } = await daos.story.scenes.addDecision(start.id, { text: 'Dál', targetSceneId: ending.id });

  await expectError(await removeScene(extra.id, null), 401, 'NOT_AUTHENTICATED');
  await expectError(await removeScene(extra.id, PETR), 403, 'userNotAuthorized');
  await expectError(await removeScene(start.id), 409, 'initialSceneDeleteForbidden');
  const blocked = await expectError(await removeScene(ending.id), 409, 'sceneHasIncomingDecisions');
  assert.deepEqual(blocked.details.incomingDecisions, [
    { sceneId: start.id, sceneName: start.name, decisionId: decision.id, text: 'Dál' },
  ]);
  assert.equal((await removeScene(extra.id)).status, 200);
  assert.equal(await daos.story.scenes.get(extra.id), null);
  await expectError(await removeScene(extra.id), 404, 'sceneNotFound');
  await expectError(await removeScene(seedScenes.at(-1).id), 409, 'storyNotEditable');
});

test('a concurrent decision and scene deletion cannot leave a dangling reference', async () => {
  const { id: storyId } = await draft();
  const start = await addScene(storyId, 'Začátek', 'initial');
  const ending = await addScene(storyId, 'Výsledek', 'final');
  const [addition, deletion] = await Promise.all([
    addDecision({ sceneId: start.id, targetSceneId: ending.id, text: 'Dál' }), removeScene(ending.id),
  ]);
  if (addition.status === 201) {
    await expectError(deletion, 409, 'sceneHasIncomingDecisions');
  } else {
    assert.equal(deletion.status, 200);
    await expectError(addition, 404, 'targetSceneNotFound');
  }
  const source = await daos.story.scenes.get(start.id);
  assert.equal(source.decisions.length === 1, Boolean(await daos.story.scenes.get(ending.id)));
});
