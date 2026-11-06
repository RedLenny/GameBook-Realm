import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOrigins } from './config.js';
import healthRouter from './routes/health.js';
import createItemsRouter from './routes/items.js';
import { createItemsStore } from './store/itemsStore.js';
import { notFound, errorHandler } from './middleware/errors.js';

export function createApp({ itemsStore = createItemsStore() } = {}) {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/items', createItemsRouter(itemsStore));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
