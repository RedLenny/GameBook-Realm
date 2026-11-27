import { MongoClient, ObjectId } from 'mongodb';
import { mongoDbPrefix, mongoUri } from '../config.js';

// Připojení k MongoDB. Každá služba dostane vlastní databázi (`gamebook_story`, `gamebook_gameplay`…),
// takže si svá data drží sama, jak počítá architektura.
export async function connectDatabase({ uri = mongoUri, dbName, client: existingClient } = {}) {
  if (!dbName) throw new Error('dbName is required');
  const client = existingClient ?? new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  if (!existingClient) await client.connect();
  return {
    client,
    db: client.db(dbName),
    close: () => (existingClient ? Promise.resolve() : client.close()),
  };
}

export const serviceDbName = (service, prefix = mongoDbPrefix) => `${prefix}_${service}`;

// The driver opens a connection on the first database operation. The existing
// health endpoints can still start before MongoDB is available.
export function serviceDatabase(service) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2000 });
  return client.db(serviceDbName(service));
}

export class DuplicateKeyError extends Error {
  constructor(message = 'Záznam již existuje', cause) {
    super(message, { cause });
    this.name = 'DuplicateKeyError';
  }
}

export const isDuplicateKey = (error) => error?.code === 11000;

// Id z API (24 hex znaků) → ObjectId. Neplatné id vrací null, DAO pak záznam „nenajde“.
export function toObjectId(id) {
  if (id instanceof ObjectId) return id;
  return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

export const newId = () => new ObjectId();

export function toDate(value) {
  if (value === undefined || value === null) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${value}`);
  return date;
}

// Hodnoty z databáze → tvar používaný v API (ObjectId → hex string, Date → ISO string).
export function toApi(value) {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toApi);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key === '_id' ? 'id' : key] = toApi(item);
    }
    return result;
  }
  return value;
}

export const fromDoc = (doc) => (doc ? toApi(doc) : null);

// Pomocná funkce pro stránkování seznamů.
export function page({ limit = 50, skip = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100);
  const safeSkip = Math.max(Number.parseInt(skip, 10) || 0, 0);
  return { limit: safeLimit, skip: safeSkip };
}

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
