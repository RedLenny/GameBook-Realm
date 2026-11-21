import { randomUUID } from 'node:crypto';

export function createAuditClient(client, source) {
  return {
    record({ id = randomUUID(), type, entityId, data = {}, occurredAt = new Date().toISOString() }, { requestId } = {}) {
      return client.request('/internal/events', {
        method: 'POST',
        requestId,
        body: { id, source, type, occurredAt, ...(entityId !== undefined && { entityId }), data },
      });
    },
  };
}
