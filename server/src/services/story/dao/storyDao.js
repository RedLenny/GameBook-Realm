import { escapeRegex, fromDoc, page, toDate, toObjectId } from '../../../shared/db.js';

const EDITABLE = ['name', 'description', 'genre'];

// Story DAO: příběhy (kolekce `stories`, databáze Story Service).
// Neřeší oprávnění ani validaci vstupu, to dělají endpointy. Hlídá jen pravidla,
// která musí platit atomicky (např. upravit jde jen koncept).
export function createStoryDao(db) {
  const stories = db.collection('stories');

  return {
    collection: stories,

    async ensureIndexes() {
      await stories.createIndexes([
        { key: { authorId: 1, updatedAt: -1 }, name: 'author_updated' },
        { key: { state: 1, publishedAt: -1 }, name: 'state_published' },
        { key: { state: 1, genre: 1 }, name: 'state_genre' },
      ]);
    },

    async create({ name, description = '', genre = null, authorId }, { now = new Date() } = {}) {
      const doc = {
        name, description, genre, authorId,
        state: 'draft',
        createdAt: now, updatedAt: now, publishedAt: null,
      };
      const { insertedId } = await stories.insertOne(doc);
      return fromDoc({ _id: insertedId, ...doc });
    },

    async get(id) {
      const _id = toObjectId(id);
      return _id ? fromDoc(await stories.findOne({ _id })) : null;
    },

    // Upraví název, popis nebo žánr. Ostatní klíče ignoruje.
    // `onlyDraft` (výchozí true) zajistí, že publikovaný příběh zůstane beze změny.
    async update(id, patch, { onlyDraft = true, now = new Date() } = {}) {
      const _id = toObjectId(id);
      if (!_id) return null;
      const $set = { updatedAt: now };
      for (const key of EDITABLE) if (patch[key] !== undefined) $set[key] = patch[key];
      const filter = onlyDraft ? { _id, state: 'draft' } : { _id };
      return fromDoc(await stories.findOneAndUpdate(filter, { $set }, { returnDocument: 'after' }));
    },

    // Koncept → publikováno. Vrací null, pokud příběh neexistuje nebo už je publikovaný.
    async publish(id, { now = new Date() } = {}) {
      const _id = toObjectId(id);
      if (!_id) return null;
      return fromDoc(await stories.findOneAndUpdate(
        { _id, state: 'draft' },
        { $set: { state: 'published', publishedAt: now, updatedAt: now } },
        { returnDocument: 'after' },
      ));
    },

    async delete(id) {
      const _id = toObjectId(id);
      if (!_id) return false;
      const { deletedCount } = await stories.deleteOne({ _id });
      return deletedCount === 1;
    },

    // „Moje příběhy“: všechny příběhy autora, nejnověji upravené první.
    async listByAuthor(authorId, { state, ...paging } = {}) {
      const { limit, skip } = page(paging);
      const filter = { authorId, ...(state && { state }) };
      const [items, total] = await Promise.all([
        stories.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        stories.countDocuments(filter),
      ]);
      return { items: items.map(fromDoc), total };
    },

    // Katalog a vyhledávání (Search Stories): jen publikované příběhy,
    // název obsahuje hledaný výraz (bez ohledu na velikost písmen), volitelně podle žánru.
    async listPublished({ name, genre, ...paging } = {}) {
      const { limit, skip } = page(paging);
      const filter = { state: 'published' };
      if (name?.trim()) filter.name = { $regex: escapeRegex(name.trim()), $options: 'i' };
      if (genre) filter.genre = genre;
      const [items, total] = await Promise.all([
        stories.find(filter).sort({ publishedAt: -1, _id: -1 }).skip(skip).limit(limit).toArray(),
        stories.countDocuments(filter),
      ]);
      return { items: items.map(fromDoc), total };
    },

    // Seznam žánrů publikovaných příběhů pro filtr v katalogu.
    async listPublishedGenres() {
      const genres = await stories.distinct('genre', { state: 'published', genre: { $nin: [null, ''] } });
      return genres.sort((a, b) => a.localeCompare(b, 'cs'));
    },

    // Pro seed a testy: vloží příběh s daným id, existující přepíše.
    async upsert(story) {
      const { id, ...rest } = story;
      const doc = {
        ...rest,
        createdAt: toDate(rest.createdAt),
        updatedAt: toDate(rest.updatedAt),
        publishedAt: toDate(rest.publishedAt ?? null),
      };
      await stories.replaceOne({ _id: toObjectId(id) }, doc, { upsert: true });
      return this.get(id);
    },
  };
}
