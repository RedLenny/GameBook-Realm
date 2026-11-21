import { createServiceApp } from '../../shared/serviceApp.js';

export function createGameplayApp(options = {}) {
  return createServiceApp({
    name: 'gameplay',
    prefix: '/api/playthroughs',
    dependencies: ['story', 'audit'],
    ...options,
  });
}
