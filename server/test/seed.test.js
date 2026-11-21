import assert from 'node:assert/strict';
import { test } from 'node:test';
import { story, scenes } from '../src/seed/ztracenyDukaz.js';

// Seed „Ztracený důkaz“ musí splňovat pravidla publikace (Business Model, Application Profiles)
// a limity ze storySchema / sceneSchema (Application Model → Persistence Layer).

const byId = new Map(scenes.map((s) => [s.id, s]));
const initial = scenes.find((s) => s.type === 'initial');

test('seed má 6 scén, jednu úvodní a dvě koncové', () => {
  assert.equal(scenes.length, 6);
  assert.equal(scenes.filter((s) => s.type === 'initial').length, 1);
  assert.equal(scenes.filter((s) => s.type === 'final').length, 2);
});

test('seed odpovídá limitům schémat', () => {
  assert.ok(story.name.trim() && story.name.length <= 120);
  assert.ok(story.description.length <= 2000);
  assert.ok(story.genre.length <= 50);
  assert.equal(story.state, 'published');
  const ids = [story.id, ...scenes.map((s) => s.id), ...scenes.flatMap((s) => s.decisions.map((d) => d.id))];
  assert.equal(new Set(ids).size, ids.length, 'id musí být unikátní');
  ids.forEach((id) => assert.match(id, /^[0-9a-f]{24}$/));
  for (const scene of scenes) {
    assert.equal(scene.storyId, story.id);
    assert.ok(scene.name.length <= 120);
    assert.ok(scene.content.length <= 10000);
    for (const d of scene.decisions) assert.ok(d.text.length > 0 && d.text.length <= 255);
  }
});

test('koncové scény nemají rozhodnutí, ostatní ano', () => {
  for (const scene of scenes) {
    if (scene.type === 'final') assert.equal(scene.decisions.length, 0, scene.name);
    else assert.ok(scene.decisions.length > 0, `${scene.name}: slepá větev`);
  }
});

test('rozhodnutí vedou na existující jinou scénu stejného příběhu', () => {
  for (const scene of scenes) {
    for (const d of scene.decisions) {
      assert.ok(byId.has(d.targetSceneId), d.id);
      assert.notEqual(d.targetSceneId, scene.id, d.id);
    }
  }
});

test('všechny scény jsou dosažitelné z úvodní a z každé se dá dojít do konce', () => {
  const reachable = new Set([initial.id]);
  const queue = [initial.id];
  while (queue.length) {
    for (const d of byId.get(queue.shift()).decisions) {
      if (!reachable.has(d.targetSceneId)) {
        reachable.add(d.targetSceneId);
        queue.push(d.targetSceneId);
      }
    }
  }
  assert.equal(reachable.size, scenes.length);

  const canFinish = (id, seen = new Set()) => {
    const s = byId.get(id);
    if (s.type === 'final') return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return s.decisions.some((d) => canFinish(d.targetSceneId, seen));
  };
  scenes.forEach((s) => assert.ok(canFinish(s.id), s.name));
});
