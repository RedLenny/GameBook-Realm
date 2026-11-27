import { escapeRegex, fromDoc, page, toObjectId } from '../../../shared/db.js';
import { publishedStory } from '../../../shared/publishedStories.js';
import { createRatingDao } from './ratingDao.js';

export function createStoryIndexDao(db) {
  const index = db.collection('storyIndex');
  const ratings = createRatingDao(db);
  return {
    ensureIndexes: () => index.createIndexes([
      { key: { state: 1, _id: 1 } },
      { key: { state: 1, publishedAt: -1, _id: -1 } },
      { key: { state: 1, genre: 1, publishedAt: -1, _id: -1 } },
    ]),
    async put(story, { restore = false } = {}) {
      const { id, publishedAt, ...metadata } = publishedStory.parse(story);
      const _id = toObjectId(id);
      const doc = { _id, ...metadata, publishedAt: publishedAt && new Date(publishedAt) };
      // Published story IDs are immutable. A delayed publication notification
      // must not resurrect a story whose deletion already reached Discovery.
      // The explicit seed command can restore its one fixed story ID.
      const replacement = { $literal: doc };
      const next = restore ? replacement : { $cond: [{ $eq: ['$state', 'deleted'] }, '$$ROOT', replacement] };
      await index.updateOne({ _id }, [{ $replaceWith: next }], { upsert: true });
    },
    async remove(id) {
      const _id = toObjectId(id);
      await index.replaceOne({ _id }, { _id, state: 'deleted' }, { upsert: true });
    },
    async activeIdsAfter(after, limit) {
      const filter = { state: 'published' };
      if (after) filter._id = { $gt: toObjectId(after) };
      const rows = await index.find(filter).project({ _id: 1 }).sort({ _id: 1 }).limit(limit).toArray();
      return rows.map((row) => row._id.toHexString());
    },
    async listPublished({ name, genre, ...paging } = {}) {
      const filter = { state: 'published' };
      if (name?.trim()) filter.name = { $regex: escapeRegex(name.trim()), $options: 'i' };
      if (genre) filter.genre = genre;
      const { limit, skip } = page(paging);
      const [docs, total] = await Promise.all([
        index.find(filter).sort({ publishedAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        index.countDocuments(filter),
      ]);
      const items = docs.map(fromDoc);
      const stats = await ratings.getStatsForStories(items.map((item) => item.id));
      return { items: items.map((item) => ({ ...item, ...stats.get(item.id) })), total };
    },
    async getRatingStats(id) {
      const exists = await index.findOne({ _id: toObjectId(id), state: 'published' }, { projection: { _id: 1 } });
      return exists ? ratings.getStats(id) : null;
    },
  };
}
