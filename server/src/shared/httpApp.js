import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFound } from './errors.js';
import { requestContext } from './requestContext.js';

export function createHttpApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(requestContext);
  return app;
}

export function finishHttpApp(app) {
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
