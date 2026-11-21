import express from 'express';
import cors from 'cors';
import { corsOrigins } from './config.js';
import healthRouter from './routes/health.js';
import createItemsRouter from './routes/items.js';
import { createItemsStore } from './store/itemsStore.js';
import { createHttpApp, finishHttpApp } from './shared/httpApp.js';
import { createServiceClients } from './shared/serviceClients.js';
import { readiness } from './shared/readiness.js';
import { proxyToService } from './gateway/proxy.js';
import { createAuthRouter } from './gateway/googleAuth.js';

export function createApp({
  itemsStore = createItemsStore(),
  clients = createServiceClients(),
  authRouter = createAuthRouter({ clients }),
} = {}) {
  const app = createHttpApp();

  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);
  app.get('/api/ready', readiness('gateway', ['story', 'gameplay', 'discovery', 'audit'], clients));
  app.use('/api/items', createItemsRouter(itemsStore));
  app.use('/api/auth', authRouter);

  app.use('/api/stories', proxyToService('/api/stories', clients.story));
  app.use('/api/playthroughs', proxyToService('/api/playthroughs', clients.gameplay));
  app.use('/api/discovery', proxyToService('/api/discovery', clients.discovery));

  return finishHttpApp(app);
}
