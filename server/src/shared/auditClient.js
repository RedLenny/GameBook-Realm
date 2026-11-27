import { randomUUID } from 'node:crypto';

export function createAuditClient(client, source) {
  const create = (record, { requestId } = {}) =>
    client.request('/internal/audit/create', { method: 'POST', requestId, body: record });
  return {
    create,
    // Pro příkazy, které už data změnily: nedostupný audit nesmí vrátit chybu
    // za akci, která proběhla. Selhání se zaloguje i s requestId pro dohledání.
    async tryCreate(record, { requestId } = {}) {
      try {
        return await create(record, { requestId });
      } catch (error) {
        console.error({
          requestId, message: 'audit record failed', operation: record.operation,
          code: error.code, error: error.message,
        });
        return null;
      }
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
