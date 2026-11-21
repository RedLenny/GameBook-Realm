import {
  DuplicateKeyError, fromDoc, isDuplicateKey, newId, toDate, toObjectId,
} from '../../../shared/db.js';

const EDITABLE = ['name', 'content', 'type'];

function rethrow(error) {
  if (isDuplicateKey(error)) throw new DuplicateKeyError('Příběh už má úvodní scénu', error);
  throw error;
}

// Scene DAO: scény příběhů včetně rozhodnutí (kolekce `scenes`, databáze Story Service).
// Rozhodnutí jsou vnořená v poli `decisions` (sceneSchema v Application Modelu).
// Pravidlo „nejvýše jedna úvodní scéna“ hlídá unikátní index, porušení končí DuplicateKeyError.
export function createSceneDao(db) {
  const scenes = db.collection('scenes');

  return {
    collection: scenes,

    async ensureIndexes() {
      await scenes.createIndexes([
        { key: { storyId: 1, createdAt: 1 }, name: 'story_created' },
        { key: { storyId: 1, 'decisions.targetSceneId': 1 }, name: 'story_decision_target' },
        {
          key: { storyId: 1 },
          name: 'one_initial_per_story',
          unique: true,
          partialFilterExpression: { type: 'initial' },
        },
      ]);
    },

    async create({ storyId, name, content, type }, { now = new Date() } = {}) {
      const storyObjectId = toObjectId(storyId);
      if (!storyObjectId) throw new TypeError('Invalid storyId');
      const doc = { storyId: storyObjectId, name, content, type, decisions: [], createdAt: now, updatedAt: now };
      try {
        const { insertedId } = await scenes.insertOne(doc);
        return fromDoc({ _id: insertedId, ...doc });
      } catch (error) {
        return rethrow(error);
      }
    },

    async get(id) {
      const _id = toObjectId(id);
      return _id ? fromDoc(await scenes.findOne({ _id })) : null;
    },

    // Scéna jen pokud patří do daného příběhu (ochrana proti míchání id mezi příběhy).
    async getInStory(storyId, id) {
      const _id = toObjectId(id);
      const story = toObjectId(storyId);
      return _id && story ? fromDoc(await scenes.findOne({ _id, storyId: story })) : null;
    },

    async listByStory(storyId) {
      const story = toObjectId(storyId);
      if (!story) return [];
      const items = await scenes.find({ storyId: story }).sort({ createdAt: 1, _id: 1 }).toArray();
      return items.map(fromDoc);
    },

    async getInitial(storyId) {
      const story = toObjectId(storyId);
      return story ? fromDoc(await scenes.findOne({ storyId: story, type: 'initial' })) : null;
    },

    // Upraví název, obsah nebo typ. Změnu na „final“ povolí jen scéně bez rozhodnutí,
    // změnu na „initial“ hlídá unikátní index.
    async update(id, patch, { now = new Date() } = {}) {
      const _id = toObjectId(id);
      if (!_id) return null;
      const $set = { updatedAt: now };
      for (const key of EDITABLE) if (patch[key] !== undefined) $set[key] = patch[key];
      const filter = { _id };
      if (patch.type === 'final') filter.decisions = { $size: 0 };
      try {
        return fromDoc(await scenes.findOneAndUpdate(filter, { $set }, { returnDocument: 'after' }));
      } catch (error) {
        return rethrow(error);
      }
    },

    async delete(id) {
      const _id = toObjectId(id);
      if (!_id) return false;
      const { deletedCount } = await scenes.deleteOne({ _id });
      return deletedCount === 1;
    },

    async deleteByStory(storyId) {
      const story = toObjectId(storyId);
      if (!story) return 0;
      const { deletedCount } = await scenes.deleteMany({ storyId: story });
      return deletedCount;
    },

    // Přidá rozhodnutí (Add Decision). Atomicky odmítne koncovou scénu.
    // Vrací { scene, decision }, nebo null, když scéna neexistuje nebo je koncová.
    async addDecision(sceneId, { text, targetSceneId }, { now = new Date() } = {}) {
      const _id = toObjectId(sceneId);
      const target = toObjectId(targetSceneId);
      if (!_id || !target) return null;
      const decision = { id: newId(), text, targetSceneId: target };
      const scene = await scenes.findOneAndUpdate(
        { _id, type: { $ne: 'final' } },
        { $push: { decisions: decision }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );
      return scene ? { scene: fromDoc(scene), decision: fromDoc(decision) } : null;
    },

    async updateDecision(sceneId, decisionId, { text, targetSceneId }, { now = new Date() } = {}) {
      const _id = toObjectId(sceneId);
      const decision = toObjectId(decisionId);
      if (!_id || !decision) return null;
      const $set = { updatedAt: now };
      if (text !== undefined) $set['decisions.$.text'] = text;
      if (targetSceneId !== undefined) {
        const target = toObjectId(targetSceneId);
        if (!target) return null;
        $set['decisions.$.targetSceneId'] = target;
      }
      return fromDoc(await scenes.findOneAndUpdate(
        { _id, 'decisions.id': decision }, { $set }, { returnDocument: 'after' },
      ));
    },

    async removeDecision(sceneId, decisionId, { now = new Date() } = {}) {
      const _id = toObjectId(sceneId);
      const decision = toObjectId(decisionId);
      if (!_id || !decision) return null;
      return fromDoc(await scenes.findOneAndUpdate(
        { _id, 'decisions.id': decision },
        { $pull: { decisions: { id: decision } }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      ));
    },

    // Rozhodnutí z jiných scén, která vedou do dané scény (Delete Scene, kontrola publikace).
    async listIncomingDecisions(storyId, targetSceneId) {
      const story = toObjectId(storyId);
      const target = toObjectId(targetSceneId);
      if (!story || !target) return [];
      const sources = await scenes.find(
        { storyId: story, _id: { $ne: target }, 'decisions.targetSceneId': target },
        { projection: { name: 1, decisions: 1 } },
      ).toArray();
      return sources.flatMap((scene) => scene.decisions
        .filter((d) => d.targetSceneId.equals(target))
        .map((d) => ({
          sceneId: scene._id.toHexString(),
          sceneName: scene.name,
          decisionId: d.id.toHexString(),
          text: d.text,
        })));
    },

    // Pro seed a testy: vloží scénu s danými id, existující přepíše.
    async upsert(scene) {
      const { id, storyId, decisions = [], ...rest } = scene;
      const doc = {
        ...rest,
        storyId: toObjectId(storyId),
        decisions: decisions.map((d) => ({
          id: toObjectId(d.id), text: d.text, targetSceneId: toObjectId(d.targetSceneId),
        })),
        createdAt: toDate(rest.createdAt),
        updatedAt: toDate(rest.updatedAt),
      };
      try {
        await scenes.replaceOne({ _id: toObjectId(id) }, doc, { upsert: true });
      } catch (error) {
        rethrow(error);
      }
      return this.get(id);
    },
  };
}
