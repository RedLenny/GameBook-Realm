import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { createServiceApp } from '../../shared/serviceApp.js';
import { validateDtoIn } from '../../shared/validation.js';

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

export function createAuditApp({ maxEvents = 10000, ...options } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('Invalid audit capacity');
  // In-memory like the existing demo store; each running service owns its data.
  const events = new Map();
  const router = Router();
  router.post('/events', validateDtoIn(eventSchema), (req, res) => {
    const event = req.dtoIn.body;
    const existing = events.get(event.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.event, event)) {
        throw new AppError(409, 'EVENT_ID_CONFLICT', 'Událost s tímto id již existuje');
      }
      return res.json(existing);
    }
    const entry = { event, requestId: req.requestId, receivedAt: new Date().toISOString() };
    events.set(event.id, entry);
    if (events.size > maxEvents) events.delete(events.keys().next().value);
    res.status(201).json(entry);
  });
  router.get('/events', validateDtoIn(listSchema), (req, res) => {
    res.json(Array.from(events.values()).slice(-req.dtoIn.query.limit));
  });

  return createServiceApp({ name: 'audit', ...options, internalRouter: router });
}
