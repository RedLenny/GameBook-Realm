import { AppError } from './errors.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBody(response, serviceName) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError(502, 'INVALID_SERVICE_RESPONSE', `Služba ${serviceName} vrátila příliš velkou odpověď`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createServiceClient({ name, url, timeoutMs = 3000, token = '', fetchImpl = fetch }) {
  const origin = new URL(url);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Service URL must be an HTTP(S) origin');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid service timeout');

  async function send(path, { method = 'GET', body, requestId, authorization, signal } = {}) {
    // Only a fixed, configured service may be contacted. Callers cannot override the origin.
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new Error('Service path must be an absolute path, not a URL');
    }
    const target = new URL(path, origin);
    if (target.origin !== origin.origin) throw new Error('Invalid service origin');

    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const response = await fetchImpl(target, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(requestId && { 'x-request-id': requestId }),
          ...(token && { 'x-service-token': token }),
          ...(authorization && { authorization }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: requestSignal,
        // Redirects must not leak internal credentials to another service/origin.
        redirect: 'manual',
      });
      const text = await readBody(response, name);
      let data = null;
      if (method !== 'HEAD' && ![204, 304].includes(response.status)) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new AppError(502, 'INVALID_SERVICE_RESPONSE', `Služba ${name} vrátila neplatnou odpověď`);
        }
      }
      return { status: response.status, headers: response.headers, text, data };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (timeout.aborted) {
        throw new AppError(504, 'SERVICE_TIMEOUT', `Služba ${name} neodpověděla včas`);
      }
      if (signal?.aborted) throw new AppError(499, 'REQUEST_ABORTED', 'Požadavek byl zrušen');
      throw new AppError(502, 'SERVICE_UNAVAILABLE', `Služba ${name} není dostupná`);
    }
  }

  async function request(path, options) {
    const response = await send(path, options);
    if (response.status < 200 || response.status >= 300) {
      const { data } = response;
      // Only the common error contract is exposed; arbitrary upstream bodies stay private.
      const knownError = data && typeof data.error === 'string' && typeof data.code === 'string';
      throw new AppError(
        response.status >= 400 ? response.status : 502,
        knownError ? data.code : 'SERVICE_ERROR',
        knownError ? data.error : `Služba ${name} nemohla požadavek zpracovat`,
        knownError ? data.details : undefined,
      );
    }
    return response.data;
  }

  // Mutations are never retried implicitly: callers must define idempotency first.
  return { send, request };
}
