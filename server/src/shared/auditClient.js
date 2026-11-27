import { randomUUID } from 'node:crypto';

export function createAuditClient(client, source) {
  return {
    create(record, { requestId } = {}) {
      return client.request('/internal/audit/create', { method: 'POST', requestId, body: record });
    },
    record({ id = randomUUID(), type, entityId, data = {}, occurredAt = new Date().toISOString() }, { requestId } = {}) {
      return client.request('/internal/events', {
        method: 'POST',
        requestId,
        body: { id, source, type, occurredAt, ...(entityId !== undefined && { entityId }), data },
      });
    },
  };
}
