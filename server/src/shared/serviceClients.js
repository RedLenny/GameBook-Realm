import { services, serviceTimeoutMs, serviceToken } from '../config.js';
import { createServiceClient } from './serviceClient.js';

export function createServiceClients({ definitions = services, timeoutMs = serviceTimeoutMs, token = serviceToken } = {}) {
  return Object.fromEntries(Object.entries(definitions).map(([name, service]) => [
    name, createServiceClient({ name, url: service.url, timeoutMs, token }),
  ]));
}
