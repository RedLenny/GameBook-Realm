import { DuplicateKeyError, fromDoc, isDuplicateKey, page } from '../../../shared/db.js';

// AuditLog DAO: auditní události (kolekce `auditEvents`, databáze Audit Service).
// Tvar odpovídá endpointu /internal/events: { event, requestId, receivedAt }.
// Id události (UUID) je zároveň _id, takže opakované odeslání téže události neuloží duplicitu.
// occurredAt zůstává řetězcem přesně tak, jak přišel, aby šlo porovnat opakovaně odeslanou událost.
const toEntry = (doc) => {
  if (!doc) return null;
  const { _id: id, requestId, receivedAt, ...event } = doc;
  return { event: { id, ...event }, requestId, receivedAt: fromDoc(receivedAt) };
};

export function createAuditLogDao(db) {
  const events = db.collection('auditEvents');

  return {
    collection: events,

    async ensureIndexes() {
      await events.createIndexes([
        { key: { receivedAt: -1 }, name: 'received' },
        { key: { entityId: 1, receivedAt: -1 }, name: 'entity_received' },
        { key: { type: 1, receivedAt: -1 }, name: 'type_received' },
      ]);
    },

    // Uloží událost. Pokud už událost se stejným id existuje, vyhodí DuplicateKeyError
    // (endpoint pak porovná obsah přes get a vrátí původní záznam, nebo 409).
    async create(event, { requestId, now = new Date() } = {}) {
      const { id, ...rest } = event;
      const doc = { _id: id, ...rest, requestId: requestId ?? null, receivedAt: now };
      try {
        await events.insertOne(doc);
      } catch (error) {
        if (isDuplicateKey(error)) throw new DuplicateKeyError('Událost s tímto id již existuje', error);
        throw error;
      }
      return toEntry(doc);
    },

    async get(id) {
      return toEntry(await events.findOne({ _id: id }));
    },

    // Posledních N událostí v chronologickém pořadí (čtou jen Authorities).
    async list({ limit = 100, entityId, type } = {}) {
      const filter = { ...(entityId && { entityId }), ...(type && { type }) };
      const docs = await events.find(filter)
        .sort({ receivedAt: -1, _id: -1 })
        .limit(page({ limit }).limit)
        .toArray();
      return docs.reverse().map(toEntry);
    },
  };
}
