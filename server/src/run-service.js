import { services, serviceHost } from './config.js';
import { listen } from './shared/listen.js';
import { createStoryApp } from './services/story/app.js';
import { createGameplayApp } from './services/gameplay/app.js';
import { createDiscoveryApp } from './services/discovery/app.js';
import { createAuditApp } from './services/audit/app.js';

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
listen(factories[name](), { name, port: services[name].port, host: serviceHost });
