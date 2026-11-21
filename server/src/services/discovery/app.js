import { createServiceApp } from '../../shared/serviceApp.js';

export function createDiscoveryApp(options = {}) {
  return createServiceApp({
    name: 'discovery',
    prefix: '/api/discovery',
    dependencies: ['story'],
    ...options,
  });
}
