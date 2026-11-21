import express from 'express';
import { serviceToken } from '../config.js';
import { createHttpApp, finishHttpApp } from './httpApp.js';
import { internalAuth } from './internalAuth.js';
import { readiness } from './readiness.js';
import { createServiceClients } from './serviceClients.js';

export function createServiceApp({ name, prefix, dependencies = [], clients = createServiceClients(), token = serviceToken, router, internalRouter }) {
  const app = createHttpApp();
  app.use(express.json({ limit: '100kb' }));
  app.use('/internal', internalAuth(token));

  const health = (_req, res) => res.json({ status: 'ok', service: name, time: new Date().toISOString() });
  app.get('/internal/health', health);
  app.get('/internal/ready', readiness(name, dependencies, clients));
  if (internalRouter) app.use('/internal', internalRouter);

  if (prefix) {
    app.get(`${prefix}/health`, health);
    app.get(`${prefix}/ready`, readiness(name, dependencies, clients));
    if (router) app.use(prefix, router);
  }
  return finishHttpApp(app);
}
