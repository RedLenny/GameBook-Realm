// Lokální MongoDB bez Dockeru (`npm run db:local`): replica set z mongodb-memory-server,
// data v server/.mongo-data. Port lze změnit proměnnou DB_LOCAL_PORT.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.DB_LOCAL_PORT || 27017);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('DB_LOCAL_PORT musí být číslo portu');
  process.exit(1);
}
const dbPath = fileURLToPath(new URL('../.mongo-data', import.meta.url));
mkdirSync(dbPath, { recursive: true });

let replSet;
try {
  replSet = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port, dbPath, storageEngine: 'wiredTiger' }],
  });
} catch (error) {
  console.error(`MongoDB se nepodařilo spustit na portu ${port}: ${error.message}`);
  console.error('Běží už jiná MongoDB (např. docker compose)? Zastav ji, nebo nastav DB_LOCAL_PORT.');
  process.exit(1);
}

console.log(`[db] MongoDB běží: mongodb://127.0.0.1:${port}/?directConnection=true`);
console.log(`[db] Data: ${dbPath}`);
console.log('[db] Ukončení: Ctrl+C');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await replSet.stop({ doCleanup: false });
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
