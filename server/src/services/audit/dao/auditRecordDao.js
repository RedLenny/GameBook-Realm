import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../../shared/errors.js';
import { isDuplicateKey, newId, toObjectId } from '../../../shared/db.js';

function toRecord({ _id, storyId, at, ...attributes }) {
  return { id: _id.toHexString(), ...attributes, storyId: storyId?.toHexString() ?? null, at: at.toISOString() };
}

// Domain audit records are append-only. An optional caller-generated id lets
// a service repeat a timed-out write without merging unrelated operations.
export function createAuditRecordDao(db) {
  const records = db.collection('auditLog');
  return {
    ensureIndexes: () => records.createIndexes([
      { key: { storyId: 1, at: -1 } }, { key: { actorId: 1, at: -1 } },
    ]),
    async create({ id, at, storyId, ...attributes }, requestId) {
      const doc = {
        _id: id ? toObjectId(id) : newId(), ...attributes,
        storyId: storyId ? toObjectId(storyId) : null,
        at: at ? new Date(at) : new Date(), requestId,
      };
      try {
        await records.insertOne(doc);
        return { created: true, record: toRecord(doc) };
      } catch (err) {
        if (!id || !isDuplicateKey(err)) throw err;
        const existing = await records.findOne({ _id: doc._id });
        if (!existing) throw err;
        const retry = { ...doc, requestId: existing.requestId, at: at ? doc.at : existing.at };
        if (!isDeepStrictEqual(toRecord(existing), toRecord(retry))) {
          throw new AppError(409, 'auditIdConflict', 'Záznam s tímto id již existuje.');
        }
        return { created: false, record: toRecord(existing) };
      }
    },
  };
}
