import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { mongoUri } from '../config.js';
import { serviceDbName } from '../shared/db.js';
import { createStoryDao } from '../services/story/dao/storyDao.js';
import { createSceneDao } from '../services/story/dao/sceneDao.js';
import { createPlaythroughDao } from '../services/gameplay/dao/playthroughDao.js';
import { createRatingDao } from '../services/discovery/dao/ratingDao.js';
import { createAuditLogDao } from '../services/audit/dao/auditLogDao.js';
import { createAuditRecordDao } from '../services/audit/dao/auditRecordDao.js';
import { createStoryIndexDao } from '../services/discovery/dao/storyIndexDao.js';
import { story as seedStory, scenes as seedScenes } from '../seed/ztracenyDukaz.js';

// Které DAO patří ke které službě (každá služba má vlastní databázi).
export const serviceDaos = {
  story: { stories: createStoryDao, scenes: createSceneDao },
  gameplay: { playthroughs: createPlaythroughDao },
  discovery: { ratings: createRatingDao, storyIndex: createStoryIndexDao },
  audit: { auditLog: createAuditLogDao, records: createAuditRecordDao },
};

// Vytvoří DAO pro všechny služby nad jedním klientem.
export function createAllDaos(client, { dbName = serviceDbName } = {}) {
  return Object.fromEntries(Object.entries(serviceDaos).map(([service, factories]) => {
    const db = client.db(dbName(service));
    return [service, Object.fromEntries(Object.entries(factories).map(([key, create]) => [key, create(db)]))];
  }));
}

// Create Database: založí kolekce a indexy. Je idempotentní, jde spouštět opakovaně.
export async function initDatabase(client, { seed = false, dbName } = {}) {
  const daos = createAllDaos(client, { dbName });
  for (const service of Object.values(daos)) {
    for (const dao of Object.values(service)) await dao.ensureIndexes();
  }
  if (seed) await seedDatabase(daos);
  return daos;
}

// Nahraje testovací příběh „Ztracený důkaz“. Opakované spuštění data jen přepíše.
export async function seedDatabase(daos) {
  await daos.story.stories.upsert(seedStory);
  for (const scene of seedScenes) await daos.story.scenes.upsert(scene);
  await daos.discovery.storyIndex.put(seedStory, { restore: true });
  return { stories: 1, scenes: seedScenes.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = process.argv.includes('--seed');
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await initDatabase(client, { seed });
    const dbs = Object.keys(serviceDaos).map((service) => serviceDbName(service)).join(', ');
    console.log(`Databáze připraveny: ${dbs}${seed ? ' (nahrán seed „Ztracený důkaz“)' : ''}`);
  } catch (error) {
    console.error(`Inicializace databáze selhala: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
