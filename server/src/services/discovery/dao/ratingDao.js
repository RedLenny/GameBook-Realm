import {
  DuplicateKeyError, fromDoc, isDuplicateKey, page, toObjectId,
} from '../../../shared/db.js';

// Rating DAO: hodnocení příběhů (kolekce `ratings`, databáze Discovery Service).
// Jeden hráč = jedno hodnocení příběhu, hlídá to unikátní index (DuplicateKeyError).
// Průměr se počítá z hodnocení (getStats), Story Service ho neukládá.
export function createRatingDao(db) {
  const ratings = db.collection('ratings');

  return {
    collection: ratings,

    async ensureIndexes() {
      await ratings.createIndexes([
        { key: { storyId: 1, playerId: 1 }, name: 'one_rating_per_player', unique: true },
        { key: { storyId: 1, createdAt: -1 }, name: 'story_created' },
      ]);
    },

    async create({ storyId, playerId, playthroughId, value }, { now = new Date() } = {}) {
      const story = toObjectId(storyId);
      const playthrough = toObjectId(playthroughId);
      if (!story || !playthrough) throw new TypeError('Invalid storyId or playthroughId');
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new RangeError('value must be 1–5');
      const doc = { storyId: story, playerId, playthroughId: playthrough, value, createdAt: now };
      try {
        const { insertedId } = await ratings.insertOne(doc);
        return fromDoc({ _id: insertedId, ...doc });
      } catch (error) {
        if (isDuplicateKey(error)) throw new DuplicateKeyError('Tento příběh jste již ohodnotili', error);
        throw error;
      }
    },

    async getByStoryAndPlayer(storyId, playerId) {
      const story = toObjectId(storyId);
      return story ? fromDoc(await ratings.findOne({ storyId: story, playerId })) : null;
    },

    async listByStory(storyId, paging = {}) {
      const story = toObjectId(storyId);
      if (!story) return { items: [], total: 0 };
      const { limit, skip } = page(paging);
      const [items, total] = await Promise.all([
        ratings.find({ storyId: story }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        ratings.countDocuments({ storyId: story }),
      ]);
      return { items: items.map(fromDoc), total };
    },

    // Průměr a počet hodnocení pro více příběhů najednou (katalog).
    // Vrací Map storyId → { averageRating, ratingCount }; příběh bez hodnocení má 0 / null.
    async getStatsForStories(storyIds) {
      const ids = storyIds.map(toObjectId).filter(Boolean);
      const stats = new Map(storyIds.map((id) => [id, { averageRating: null, ratingCount: 0 }]));
      if (!ids.length) return stats;
      const rows = await ratings.aggregate([
        { $match: { storyId: { $in: ids } } },
        { $group: {
          _id: '$storyId',
          averageRating: { $avg: { $ifNull: ['$stars', '$value'] } },
          ratingCount: { $sum: 1 },
        } },
      ]).toArray();
      for (const row of rows) {
        stats.set(row._id.toHexString(), {
          averageRating: Math.round(row.averageRating * 10) / 10,
          ratingCount: row.ratingCount,
        });
      }
      return stats;
    },

    async getStats(storyId) {
      return (await this.getStatsForStories([storyId])).get(storyId);
    },

    async deleteByStory(storyId) {
      const story = toObjectId(storyId);
      if (!story) return 0;
      const { deletedCount } = await ratings.deleteMany({ storyId: story });
      return deletedCount;
    },
  };
}
