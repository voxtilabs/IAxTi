/** Transportes de infraestructura, sin SQL, contexto de negocio ni URLs del caller. */
export interface GoogleTransportOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface GoogleRequestOptions { signal?: AbortSignal }

export type GoogleErrorCode =
  | 'GOOGLE_CONFIGURATION_INVALID' | 'GOOGLE_INPUT_INVALID' | 'GOOGLE_RESPONSE_INVALID'
  | 'GOOGLE_REQUEST_FAILED' | 'GOOGLE_TIMEOUT' | 'GOOGLE_REQUEST_ABORTED'
  | 'GOOGLE_PERMISSION_DENIED' | 'GOOGLE_NOT_FOUND' | 'GOOGLE_ALREADY_EXISTS'
  | 'GOOGLE_INVALID_GRANT' | 'GOOGLE_INVALID_TOKEN' | 'GOOGLE_ID_TOKEN_INVALID' | 'GOOGLE_FREEBUSY_UNAVAILABLE';

/** No conserva cause, request, URL, cuerpo ni mensajes de SDK/proveedor. */
export class GoogleIntegrationError extends Error {
  constructor(public readonly code: GoogleErrorCode, public readonly status?: number) {
    super(code);
    this.name = 'GoogleIntegrationError';
  }
}

export function invalidInput(): never { throw new GoogleIntegrationError('GOOGLE_INPUT_INVALID'); }
export function invalidResponse(): never { throw new GoogleIntegrationError('GOOGLE_RESPONSE_INVALID'); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 16384): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) return invalidResponse();
  return value;
}
export function inputText(value: string, max = 16384): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) return invalidInput();
  return value;
}
export function bearer(value: string): string { return `Bearer ${inputText(value)}`; }

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createTransport(options: GoogleTransportOptions = {}) {
  const send = options.fetch ?? globalThis.fetch;
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120000) {
    throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  }
  return async (url: string, init: RequestInit, request: GoogleRequestOptions = {}): Promise<unknown> => {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    if (request.signal?.aborted) throw new GoogleIntegrationError('GOOGLE_REQUEST_ABORTED');
    request.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeout);
    timer.unref?.();
    try {
      const response = await send(url, { ...init, redirect: 'error', signal: abort.signal });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_BODY_BYTES) {
            await reader.cancel();
            return invalidResponse();
          }
          chunks.push(value);
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      if (!response.ok) {
        const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
        // Solo este identificador estable afecta al lifecycle; el texto externo se descarta.
        const code: GoogleErrorCode = error === 'invalid_grant' ? 'GOOGLE_INVALID_GRANT'
          : error === 'invalid_token' ? 'GOOGLE_INVALID_TOKEN'
          : response.status === 401 || response.status === 403 ? 'GOOGLE_PERMISSION_DENIED'
          : response.status === 404 ? 'GOOGLE_NOT_FOUND'
          : response.status === 409 ? 'GOOGLE_ALREADY_EXISTS' : 'GOOGLE_REQUEST_FAILED';
        throw new GoogleIntegrationError(code, response.status);
      }
      if (raw && body === null) return invalidResponse();
      return body;
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      throw new GoogleIntegrationError(timedOut ? 'GOOGLE_TIMEOUT'
        : request.signal?.aborted ? 'GOOGLE_REQUEST_ABORTED' : 'GOOGLE_REQUEST_FAILED');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', cancel);
    }
  };
}
