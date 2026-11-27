import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { corsOrigins, googleAuth } from './config.js';
import healthRouter from './routes/health.js';
import createItemsRouter from './routes/items.js';
import { createItemsStore } from './store/itemsStore.js';
import { createHttpApp, finishHttpApp } from './shared/httpApp.js';
import { createServiceClients } from './shared/serviceClients.js';
import { readiness } from './shared/readiness.js';
import { proxyToService } from './gateway/proxy.js';
import { createAuthRouter, readSession } from './gateway/googleAuth.js';
import { AppError } from './shared/errors.js';

export function createApp({
  itemsStore = createItemsStore(),
  clients = createServiceClients(),
  sessionConfig = googleAuth,
  authRouter = createAuthRouter({ clients, config: sessionConfig }),
} = {}) {
  const app = createHttpApp();

  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);
  app.get('/api/ready', readiness('gateway', ['story', 'gameplay', 'discovery', 'audit'], clients));
  app.use('/api/items', createItemsRouter(itemsStore));
  app.use('/api/auth', authRouter);

  // Příkazy, které potřebují přihlášeného uživatele. Gateway ověří session
  // a službě předá jeho id v hlavičce x-player-id (viz proxyToService).
  const requireSession = [cookieParser(), (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    const session = readSession(req, sessionConfig);
    if (typeof session?.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(session.sub)) {
      return next(new AppError(401, 'NOT_AUTHENTICATED', 'Nejste přihlášen.'));
    }
    req.authenticatedPlayerId = session.sub;
    next();
  }];
  app.get([
    '/api/stories/story/get', '/api/stories/story/list',
    '/api/playthroughs/list', '/api/discovery/rating/getStats',
  ], requireSession);
  app.post([
    '/api/stories/story/create', '/api/stories/scene/create', '/api/stories/decision/create',
    '/api/playthroughs/start', '/api/discovery/rating/create',
  ], requireSession);

  app.use('/api/stories', proxyToService('/api/stories', clients.story));
  app.use('/api/playthroughs', proxyToService('/api/playthroughs', clients.gameplay));
  app.use('/api/discovery', proxyToService('/api/discovery', clients.discovery));

  return finishHttpApp(app);
}
