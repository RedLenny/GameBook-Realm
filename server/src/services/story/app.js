import { createServiceApp } from '../../shared/serviceApp.js';

export function createStoryApp(options = {}) {
  return createServiceApp({
    name: 'story',
    prefix: '/api/stories',
    dependencies: ['audit'],
    ...options,
  });
}
