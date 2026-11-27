import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, asyncHandler } from '../../shared/errors.js';
import { createServiceApp } from '../../shared/serviceApp.js';
import { validateDtoIn } from '../../shared/validation.js';
import { DuplicateKeyError, serviceDatabase } from '../../shared/db.js';
import { serviceToken } from '../../config.js';
import { mountAuditCreate } from './createCommand.js';
import { createAuditLogDao } from './dao/auditLogDao.js';

const eventSchema = z.object({
  body: z.object({
    id: z.string().uuid(),
    source: z.enum(['gateway', 'story', 'gameplay', 'discovery']),
    type: z.string().trim().min(1).max(100),
    occurredAt: z.string().datetime(),
    entityId: z.string().min(1).max(200).optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
});
const listSchema = z.object({
  query: z.object({
    limit: z.string().regex(/^\d+$/).transform(Number)
      .pipe(z.number().int().min(1).max(100)).default(100),
  }).strict(),
});

export function createAuditApp({ db = serviceDatabase('audit'), token = serviceToken, ...options } = {}) {
  // Opakované odeslání téže události vrátí původní záznam, jiný obsah se stejným id 409.
  const events = createAuditLogDao(db);
  const router = Router();
  mountAuditCreate(router, db, token);
  router.post('/events', validateDtoIn(eventSchema), asyncHandler(async (req, res) => {
    const event = req.dtoIn.body;
    try {
      res.status(201).json(await events.create(event, { requestId: req.requestId }));
    } catch (error) {
      if (!(error instanceof DuplicateKeyError)) throw error;
      const existing = await events.get(event.id);
      if (!existing || !isDeepStrictEqual(existing.event, event)) {
        throw new AppError(409, 'EVENT_ID_CONFLICT', 'Událost s tímto id již existuje');
      }
      res.json(existing);
    }
  }));
  router.get('/events', validateDtoIn(listSchema), asyncHandler(async (req, res) => {
    res.json(await events.list({ limit: req.dtoIn.query.limit }));
  }));

  return createServiceApp({ name: 'audit', ...options, token, internalRouter: router });
}
