import { fromDoc, page, toObjectId } from '../../../shared/db.js';

// Playthrough DAO: hraní příběhů (kolekce `playthroughs`, databáze Gameplay Service).
// Scény a příběhy patří Story Service, tady jsou jen jejich id.
export function createPlaythroughDao(db) {
  const playthroughs = db.collection('playthroughs');

  return {
    collection: playthroughs,

    async ensureIndexes() {
      await playthroughs.createIndexes([
        { key: { playerId: 1, state: 1, updatedAt: -1 }, name: 'player_state_updated' },
        { key: { storyId: 1 }, name: 'story' },
      ]);
    },

    // Start Playthrough: nové hraní začíná na úvodní scéně.
    async create({ storyId, playerId, initialSceneId }, { now = new Date() } = {}) {
      const story = toObjectId(storyId);
      const scene = toObjectId(initialSceneId);
      if (!story || !scene) throw new TypeError('Invalid storyId or initialSceneId');
      const doc = {
        storyId: story,
        playerId,
        state: 'inProgress',
        currentSceneId: scene,
        decisionHistory: [],
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      const { insertedId } = await playthroughs.insertOne(doc);
      return fromDoc({ _id: insertedId, ...doc });
    },

    async get(id) {
      const _id = toObjectId(id);
      return _id ? fromDoc(await playthroughs.findOne({ _id })) : null;
    },

    // Continue Playthrough: hraní hráče, výchozí jen rozehraná, naposledy hraná první.
    async listByPlayer(playerId, { state = 'inProgress', ...paging } = {}) {
      const { limit, skip } = page(paging);
      const filter = { playerId, ...(state && { state }) };
      const [items, total] = await Promise.all([
        playthroughs.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        playthroughs.countDocuments(filter),
      ]);
      return { items: items.map(fromDoc), total };
    },

    // Progress belongs to a player/story pair across all attempts. Legacy
    // records store each choice's origin and the current scene, newer ones
    // can also carry the model's explicit visitedSceneIds.
    async visitedCounts(playerId, storyIds) {
      const rows = await playthroughs.aggregate([
        { $match: { playerId, storyId: { $in: storyIds.map(toObjectId) } } },
        { $project: { storyId: 1, visited: { $setUnion: [
          { $ifNull: ['$visitedSceneIds', []] }, { $ifNull: ['$decisionHistory.sceneId', []] },
          { $ifNull: ['$history.sceneId', []] }, ['$currentSceneId'],
        ] } } },
        { $unwind: '$visited' },
        { $match: { visited: { $ne: null } } },
        { $group: { _id: { story: '$storyId', scene: { $toString: '$visited' } } } },
        { $group: { _id: '$_id.story', count: { $sum: 1 } } },
      ]).toArray();
      return new Map(rows.map((row) => [row._id.toHexString(), row.count]));
    },

    async findInProgress(storyId, playerId) {
      const story = toObjectId(storyId);
      if (!story) return null;
      return fromDoc(await playthroughs.findOne(
        { storyId: story, playerId, state: 'inProgress' }, { sort: { updatedAt: -1 } },
      ));
    },

    // Zapíše rozhodnutí a posune hráče do cílové scény. `finished: true` = cíl je koncová scéna.
    // Podmínka na currentSceneId brání dvojímu kliknutí: když se mezitím hraní posunulo,
    // vrátí null a nic nezapíše.
    async recordDecision(id, { sceneId, decisionId, targetSceneId, finished = false }, { now = new Date() } = {}) {
      const _id = toObjectId(id);
      const scene = toObjectId(sceneId);
      const decision = toObjectId(decisionId);
      const target = toObjectId(targetSceneId);
      if (!_id || !scene || !decision || !target) return null;
      const $set = { currentSceneId: target, updatedAt: now };
      if (finished) Object.assign($set, { state: 'finished', finishedAt: now });
      return fromDoc(await playthroughs.findOneAndUpdate(
        { _id, state: 'inProgress', currentSceneId: scene },
        { $push: { decisionHistory: { sceneId: scene, decisionId: decision, decidedAt: now } }, $set },
        { returnDocument: 'after' },
      ));
    },

    async deleteByStory(storyId) {
      const story = toObjectId(storyId);
      if (!story) return 0;
      const { deletedCount } = await playthroughs.deleteMany({ storyId: story });
      return deletedCount;
    },
  };
}
