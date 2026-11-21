import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { DuplicateKeyError } from '../src/shared/db.js';
import { initDatabase } from '../src/db/init.js';
import { story as seedStory, scenes as seedScenes, AUTHOR_ID } from '../src/seed/ztracenyDukaz.js';

// DAO testy běží proti dočasné MongoDB v paměti (mongodb-memory-server).
// Při prvním spuštění si balíček stáhne binárku MongoDB (~100 MB), pak už je v cache.

let mongo;
let client;
let daos;
let dbCounter = 0;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = new MongoClient(mongo.getUri());
  await client.connect();
});

after(async () => {
  await client?.close();
  await mongo?.stop();
});

// Každý blok testů dostane čisté databáze.
async function freshDaos({ seed = false } = {}) {
  const run = ++dbCounter;
  return initDatabase(client, { seed, dbName: (service) => `test${run}_${service}` });
}

describe('Create Database', () => {
  test('založí indexy a je idempotentní', async () => {
    daos = await freshDaos();
    await initDatabase(client, { dbName: (service) => `test${dbCounter}_${service}` });
    const indexes = await daos.story.scenes.collection.indexes();
    assert.ok(indexes.some((i) => i.name === 'one_initial_per_story' && i.unique));
    const ratingIndexes = await daos.discovery.ratings.collection.indexes();
    assert.ok(ratingIndexes.some((i) => i.name === 'one_rating_per_player' && i.unique));
  });

  test('seed nahraje „Ztracený důkaz“ se stejnými id', async () => {
    daos = await freshDaos({ seed: true });
    const story = await daos.story.stories.get(seedStory.id);
    assert.equal(story.name, 'Ztracený důkaz');
    assert.equal(story.state, 'published');
    const scenes = await daos.story.scenes.listByStory(seedStory.id);
    assert.equal(scenes.length, seedScenes.length);
    const initial = await daos.story.scenes.getInitial(seedStory.id);
    assert.deepEqual(initial.decisions, seedScenes[0].decisions);
  });
});

describe('Story DAO', () => {
  before(async () => { daos = await freshDaos({ seed: true }); });

  test('create → koncept s časy, get vrací stejná data', async () => {
    const created = await daos.story.stories.create({ name: 'Nový příběh', genre: 'Fantasy', authorId: 'a1' });
    assert.match(created.id, /^[0-9a-f]{24}$/);
    assert.equal(created.state, 'draft');
    assert.equal(created.publishedAt, null);
    assert.deepEqual(await daos.story.stories.get(created.id), created);
  });

  test('get s neplatným nebo neexistujícím id vrací null', async () => {
    assert.equal(await daos.story.stories.get('nesmysl'), null);
    assert.equal(await daos.story.stories.get('000000000000000000000000'), null);
  });

  test('update mění jen povolená pole a jen u konceptu', async () => {
    const { id } = await daos.story.stories.create({ name: 'Původní', authorId: 'a1' });
    const updated = await daos.story.stories.update(id, { name: 'Nový název', state: 'published', authorId: 'x' });
    assert.equal(updated.name, 'Nový název');
    assert.equal(updated.state, 'draft');
    assert.equal(updated.authorId, 'a1');
    assert.equal(await daos.story.stories.update(seedStory.id, { name: 'Hack' }), null, 'publikovaný je zamčený');
  });

  test('publish jen jednou', async () => {
    const { id } = await daos.story.stories.create({ name: 'K publikaci', authorId: 'a1' });
    const published = await daos.story.stories.publish(id);
    assert.equal(published.state, 'published');
    assert.ok(published.publishedAt);
    assert.equal(await daos.story.stories.publish(id), null);
  });

  test('listByAuthor a listPublished s hledáním a žánrem', async () => {
    const mine = await daos.story.stories.listByAuthor('a1');
    assert.ok(mine.total >= 3);
    assert.ok(mine.items.every((s) => s.authorId === 'a1'));

    const found = await daos.story.stories.listPublished({ name: 'ztracený' });
    assert.deepEqual(found.items.map((s) => s.id), [seedStory.id]);
    assert.equal((await daos.story.stories.listPublished({ name: 'ztracený', genre: 'Fantasy' })).total, 0);
    assert.equal((await daos.story.stories.listPublished({ name: '.*' })).total, 0, 'regex znaky se escapují');
    const drafts = await daos.story.stories.listPublished({ name: 'Původní' });
    assert.equal(drafts.total, 0, 'koncepty se v katalogu nezobrazí');
    assert.deepEqual(await daos.story.stories.listPublishedGenres(), ['Detektivka'], 'jen žánry publikovaných');
  });

  test('delete', async () => {
    const { id } = await daos.story.stories.create({ name: 'Smazat', authorId: 'a1' });
    assert.equal(await daos.story.stories.delete(id), true);
    assert.equal(await daos.story.stories.delete(id), false);
  });
});

describe('Scene DAO', () => {
  let storyId;
  before(async () => {
    daos = await freshDaos();
    ({ id: storyId } = await daos.story.stories.create({ name: 'Scény', authorId: AUTHOR_ID }));
  });

  test('jen jedna úvodní scéna na příběh', async () => {
    const initial = await daos.story.scenes.create({ storyId, name: 'Začátek', content: 'Text', type: 'initial' });
    assert.equal(initial.type, 'initial');
    assert.deepEqual(initial.decisions, []);
    await assert.rejects(
      daos.story.scenes.create({ storyId, name: 'Druhý začátek', content: 'Text', type: 'initial' }),
      DuplicateKeyError,
    );
    const regular = await daos.story.scenes.create({ storyId, name: 'Běžná', content: 'Text', type: 'regular' });
    await assert.rejects(daos.story.scenes.update(regular.id, { type: 'initial' }), DuplicateKeyError);
  });

  test('addDecision, updateDecision, removeDecision', async () => {
    const from = await daos.story.scenes.create({ storyId, name: 'Rozcestí', content: 'Kam?', type: 'regular' });
    const to = await daos.story.scenes.create({ storyId, name: 'Konec', content: 'Konec.', type: 'final' });

    const { scene, decision } = await daos.story.scenes.addDecision(from.id, { text: 'Jít dál', targetSceneId: to.id });
    assert.match(decision.id, /^[0-9a-f]{24}$/);
    assert.deepEqual(scene.decisions, [{ id: decision.id, text: 'Jít dál', targetSceneId: to.id }]);

    const updated = await daos.story.scenes.updateDecision(from.id, decision.id, { text: 'Jít rovně' });
    assert.equal(updated.decisions[0].text, 'Jít rovně');

    const removed = await daos.story.scenes.removeDecision(from.id, decision.id);
    assert.deepEqual(removed.decisions, []);
    assert.equal(await daos.story.scenes.removeDecision(from.id, decision.id), null);
  });

  test('z koncové scény nelze přidat rozhodnutí a scénu s rozhodnutími nelze změnit na koncovou', async () => {
    const end = await daos.story.scenes.create({ storyId, name: 'Konec 2', content: 'Konec.', type: 'final' });
    const other = await daos.story.scenes.create({ storyId, name: 'Jiná', content: 'X', type: 'regular' });
    assert.equal(await daos.story.scenes.addDecision(end.id, { text: 'Ne', targetSceneId: other.id }), null);

    await daos.story.scenes.addDecision(other.id, { text: 'Do konce', targetSceneId: end.id });
    assert.equal(await daos.story.scenes.update(other.id, { type: 'final' }), null);
    const renamed = await daos.story.scenes.update(other.id, { name: 'Přejmenovaná' });
    assert.equal(renamed.name, 'Přejmenovaná');
  });

  test('listIncomingDecisions najde rozhodnutí vedoucí do scény', async () => {
    const target = await daos.story.scenes.create({ storyId, name: 'Cíl', content: 'X', type: 'regular' });
    const source = await daos.story.scenes.create({ storyId, name: 'Zdroj', content: 'X', type: 'regular' });
    const { decision } = await daos.story.scenes.addDecision(source.id, { text: 'Do cíle', targetSceneId: target.id });
    assert.deepEqual(await daos.story.scenes.listIncomingDecisions(storyId, target.id), [
      { sceneId: source.id, sceneName: 'Zdroj', decisionId: decision.id, text: 'Do cíle' },
    ]);
    assert.deepEqual(await daos.story.scenes.listIncomingDecisions(storyId, source.id), []);
  });

  test('getInStory odmítne scénu z jiného příběhu, deleteByStory smaže všechny scény', async () => {
    const { id: otherStory } = await daos.story.stories.create({ name: 'Jiný', authorId: 'b' });
    const foreign = await daos.story.scenes.create({ storyId: otherStory, name: 'Cizí', content: 'X', type: 'regular' });
    assert.equal(await daos.story.scenes.getInStory(storyId, foreign.id), null);
    assert.equal((await daos.story.scenes.getInStory(otherStory, foreign.id)).id, foreign.id);
    assert.equal(await daos.story.scenes.deleteByStory(otherStory), 1);
    assert.equal(await daos.story.scenes.get(foreign.id), null);
  });
});

describe('Playthrough DAO', () => {
  before(async () => { daos = await freshDaos({ seed: true }); });

  test('create, recordDecision a dokončení hraní', async () => {
    const [s1001, , s1003, , s1005] = seedScenes;
    const pt = await daos.gameplay.playthroughs.create({
      storyId: seedStory.id, playerId: 'p1', initialSceneId: s1001.id,
    });
    assert.equal(pt.state, 'inProgress');
    assert.equal(pt.currentSceneId, s1001.id);

    const step1 = await daos.gameplay.playthroughs.recordDecision(pt.id, {
      sceneId: s1001.id, decisionId: s1001.decisions[1].id, targetSceneId: s1003.id,
    });
    assert.equal(step1.currentSceneId, s1003.id);
    assert.equal(step1.decisionHistory.length, 1);

    // Dvojí kliknutí: hráč už není ve scéně 1001, nic se nezapíše.
    assert.equal(await daos.gameplay.playthroughs.recordDecision(pt.id, {
      sceneId: s1001.id, decisionId: s1001.decisions[1].id, targetSceneId: s1003.id,
    }), null);

    const done = await daos.gameplay.playthroughs.recordDecision(pt.id, {
      sceneId: s1003.id, decisionId: s1003.decisions[0].id, targetSceneId: s1005.id, finished: true,
    });
    assert.equal(done.state, 'finished');
    assert.ok(done.finishedAt);
    assert.equal(done.decisionHistory.length, 2);
  });

  test('listByPlayer vrací rozehraná hraní hráče', async () => {
    const pt = await daos.gameplay.playthroughs.create({
      storyId: seedStory.id, playerId: 'p2', initialSceneId: seedScenes[0].id,
    });
    const list = await daos.gameplay.playthroughs.listByPlayer('p2');
    assert.deepEqual(list.items.map((p) => p.id), [pt.id]);
    assert.equal((await daos.gameplay.playthroughs.listByPlayer('p1')).total, 0, 'p1 má jen dokončené');
    assert.equal((await daos.gameplay.playthroughs.listByPlayer('p1', { state: 'finished' })).total, 1);
    assert.equal((await daos.gameplay.playthroughs.findInProgress(seedStory.id, 'p2')).id, pt.id);
  });
});

describe('Rating DAO', () => {
  before(async () => { daos = await freshDaos(); });
  const storyId = seedStory.id;
  const playthroughId = '6720a1f0c2b5a1d3e4f5aaaa';

  test('jeden hráč = jedno hodnocení', async () => {
    const rating = await daos.discovery.ratings.create({ storyId, playerId: 'p1', playthroughId, value: 4 });
    assert.equal(rating.value, 4);
    await assert.rejects(
      daos.discovery.ratings.create({ storyId, playerId: 'p1', playthroughId, value: 5 }),
      DuplicateKeyError,
    );
    assert.equal((await daos.discovery.ratings.getByStoryAndPlayer(storyId, 'p1')).id, rating.id);
  });

  test('hodnota musí být 1–5', async () => {
    await assert.rejects(daos.discovery.ratings.create({ storyId, playerId: 'p9', playthroughId, value: 6 }), RangeError);
    await assert.rejects(daos.discovery.ratings.create({ storyId, playerId: 'p9', playthroughId, value: 2.5 }), RangeError);
  });

  test('průměr a počet hodnocení', async () => {
    await daos.discovery.ratings.create({ storyId, playerId: 'p2', playthroughId, value: 5 });
    await daos.discovery.ratings.create({ storyId, playerId: 'p3', playthroughId, value: 2 });
    assert.deepEqual(await daos.discovery.ratings.getStats(storyId), { averageRating: 3.7, ratingCount: 3 });
    const other = '6720a1f0c2b5a1d3e4f5bbbb';
    const stats = await daos.discovery.ratings.getStatsForStories([storyId, other]);
    assert.deepEqual(stats.get(other), { averageRating: null, ratingCount: 0 });
    assert.equal((await daos.discovery.ratings.listByStory(storyId)).total, 3);
  });
});

describe('AuditLog DAO', () => {
  before(async () => { daos = await freshDaos(); });

  const event = (data = {}) => ({
    id: randomUUID(), source: 'story', type: 'scene.decisionAdded',
    occurredAt: '2026-11-21T20:00:00.000Z', entityId: 'scene-1', data,
  });

  test('uloží událost a vrátí ji ve tvaru endpointu', async () => {
    const input = event({ decisionId: 'd1' });
    const entry = await daos.audit.auditLog.create(input, { requestId: 'req-1' });
    assert.deepEqual(entry.event, input);
    assert.equal(entry.requestId, 'req-1');
    assert.ok(entry.receivedAt);
    assert.deepEqual(await daos.audit.auditLog.get(input.id), entry);
  });

  test('stejné id podruhé neuloží', async () => {
    const input = event();
    await daos.audit.auditLog.create(input);
    await assert.rejects(daos.audit.auditLog.create(input), DuplicateKeyError);
  });

  test('list vrací posledních N událostí chronologicky', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const input = event({ i });
      ids.push(input.id);
      await daos.audit.auditLog.create(input, { now: new Date(Date.UTC(2030, 0, 1, 0, 0, i)) });
    }
    const last = await daos.audit.auditLog.list({ limit: 2 });
    assert.deepEqual(last.map((e) => e.event.id), ids.slice(1));
  });
});
