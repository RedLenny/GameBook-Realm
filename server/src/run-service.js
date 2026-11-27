import { services, serviceHost, serviceToken } from './config.js';
import { listen } from './shared/listen.js';
import { serviceDatabase } from './shared/db.js';
import { createStoryApp } from './services/story/app.js';
import { createGameplayApp } from './services/gameplay/app.js';
import { createDiscoveryApp } from './services/discovery/app.js';
import { createAuditApp } from './services/audit/app.js';
import { createServiceClients } from './shared/serviceClients.js';
import { createStoryIndexDao } from './services/discovery/dao/storyIndexDao.js';
import { startIndexSync } from './services/discovery/syncIndex.js';

const factories = {
  story: createStoryApp,
  gameplay: createGameplayApp,
  discovery: createDiscoveryApp,
  audit: createAuditApp,
};
const name = process.argv[2];
if (!Object.hasOwn(factories, name)) {
  console.error('Usage: node src/run-service.js <story|gameplay|discovery|audit>');
  process.exit(1);
}
const db = serviceDatabase(name);
const clients = createServiceClients();
const server = listen(factories[name]({ db, clients }), {
  name, port: services[name].port, host: serviceHost, onClose: () => db.client.close(),
});
if (name === 'discovery' && serviceToken) {
  server.once('listening', () => {
    const stopSync = startIndexSync(createStoryIndexDao(db), clients.story);
    server.once('close', stopSync);
  });
}
