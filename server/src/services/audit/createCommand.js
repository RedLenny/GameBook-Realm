import { z } from 'zod';
import { commandInput, objectIdInput } from '../../shared/commandInput.js';
import { asyncHandler } from '../../shared/errors.js';
import { internalAuth } from '../../shared/internalAuth.js';
import { createAuditRecordDao } from './dao/auditRecordDao.js';

const text = z.string().trim().min(1).max(200);
const schema = z.object({
  id: objectIdInput.optional(),
  actorId: text,
  actorName: text.nullable().default(null),
  actorProfiles: z.array(z.enum(['Users', 'Authorities'])).max(2).default([]),
  operation: text.regex(/^[a-zA-Z]+\/[a-zA-Z]+$/),
  entityType: text,
  entityId: text.nullable().default(null),
  storyId: objectIdInput.nullable().default(null),
  result: z.enum(['success', 'denied', 'error']),
  errorCode: text.nullable().default(null),
  detail: z.record(z.string(), z.unknown())
    .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2048, 'Max. 2 kB')
    .default({}),
  at: z.string().datetime({ offset: true }).optional(),
});

export function mountAuditCreate(router, db, token) {
  const records = createAuditRecordDao(db);
  router.post('/audit/create', internalAuth(token, { required: true }), commandInput(schema, 'body'),
    asyncHandler(async (req, res) => {
      const { created, record } = await records.create(req.dtoIn, req.requestId);
      res.status(created ? 201 : 200).json({ ...record, uuAppErrorMap: req.uuAppErrorMap });
    }));
}
