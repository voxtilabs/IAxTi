import { GoogleAuth } from 'google-auth-library';
import { bearer, createTransport, GoogleIntegrationError, invalidInput, invalidResponse,
  record, text, type GoogleRequestOptions, type GoogleTransportOptions } from './http';

const ENDPOINT = 'https://secretmanager.googleapis.com/v1/';
export interface GoogleSecretStoreConfig { projectId: string; location: string }
export interface GoogleSecretStoreOptions extends GoogleTransportOptions {
  /** Puerto de identidad ADC, inyectable en pruebas sin una cuenta real. */
  accessToken?: () => Promise<string>;
}
export interface GoogleSecretStore {
  put(secretId: string, payload: string, options?: GoogleRequestOptions): Promise<string>;
  addVersion(secretId: string, payload: string, options?: GoogleRequestOptions): Promise<string>;
  access(versionRef: string, options?: GoogleRequestOptions): Promise<string>;
  destroy(versionRef: string, options?: GoogleRequestOptions): Promise<void>;
  /** Solo para intents de secretos nuevos aún no confirmados por el caller. */
  deleteSecret(secretId: string, options?: GoogleRequestOptions): Promise<void>;
}

/** CRC32C Castagnoli: Secret Manager devuelve este checksum del payload. */
function crc32c(bytes: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

function payloadBytes(value: string): Buffer {
  if (typeof value !== 'string' || !value) return invalidInput();
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > 65536 || bytes.toString('utf8') !== value) return invalidInput();
  return bytes;
}

export function createGoogleSecretStore(config: GoogleSecretStoreConfig, options: GoogleSecretStoreOptions = {}): GoogleSecretStore {
  if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,20})$/.test(config.projectId)
    || !/^[a-z][a-z0-9-]{1,62}$/.test(config.location) || config.location === 'automatic' || config.location === 'global') {
    throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
  }
  const project = `projects/${config.projectId}`;
  const secret = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(id)) return invalidInput();
    return `${project}/secrets/${id}`;
  };
  const version = (ref: string) => {
    const prefix = `${project}/secrets/`;
    if (!ref.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]{0,19}$/.test(ref.slice(prefix.length))) return invalidInput();
    return ref;
  };
  const auth = new GoogleAuth({ projectId: config.projectId, scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    clientOptions: { transporterOptions: { timeout: options.timeoutMs ?? 10000, retry: false,
      ...(options.fetch ? { fetchImplementation: options.fetch } : {}) } } });
  const token = options.accessToken ?? (async () => {
    const result = await auth.getAccessToken();
    if (!result) throw new GoogleIntegrationError('GOOGLE_CONFIGURATION_INVALID');
    return result;
  });
  const transport = createTransport(options);
  const accessTokenFor = async (opt: GoogleRequestOptions): Promise<string> => {
    if (opt.signal?.aborted) throw new GoogleIntegrationError('GOOGLE_REQUEST_ABORTED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new GoogleIntegrationError('GOOGLE_REQUEST_ABORTED'));
      opt.signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => reject(new GoogleIntegrationError('GOOGLE_TIMEOUT')), options.timeoutMs ?? 10000);
      timer.unref?.();
    });
    try {
      // ADC puede descubrir credenciales fuera de fetch. Acotamos también esa
      // espera; sus solicitudes propias mantienen el timeout del SDK oficial.
      return await Promise.race([Promise.resolve().then(token).catch(() => {
        throw new GoogleIntegrationError('GOOGLE_REQUEST_FAILED');
      }), interrupted]);
    } finally {
      clearTimeout(timer);
      if (cancel) opt.signal?.removeEventListener('abort', cancel);
    }
  };
  const request = async (path: string, method: string, body: unknown, opt: GoogleRequestOptions) => {
    const accessToken = await accessTokenFor(opt);
    return transport(`${ENDPOINT}${path}`, { method, headers: { Authorization: bearer(accessToken),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, opt);
  };
  const addVersion = async (id: string, payload: string, opt: GoogleRequestOptions = {}) => {
    const name = secret(id);
    const bytes = payloadBytes(payload);
    const response = record(await request(`${name}:addVersion`, 'POST', {
      payload: { data: bytes.toString('base64'), dataCrc32c: crc32c(bytes) },
    }, opt));
    const ref = text(response.name);
    if (!ref.startsWith(`${name}/versions/`)) return invalidResponse();
    try { version(ref); } catch { return invalidResponse(); }
    if (response.state !== 'ENABLED') return invalidResponse();
    return ref;
  };
  const state = async (ref: string, opt: GoogleRequestOptions) => {
    const result = record(await request(version(ref), 'GET', undefined, opt));
    if (result.name !== ref || !['ENABLED', 'DISABLED', 'DESTROYED'].includes(String(result.state))) return invalidResponse();
    return result.state;
  };
  return {
    async put(id, payload, opt = {}) {
      const name = secret(id);
      // Validar antes de crear: un payload inválido no debe dejar un secreto vacío.
      payloadBytes(payload);
      const result = record(await request(`${project}/secrets?secretId=${encodeURIComponent(id)}`, 'POST',
        { replication: { userManaged: { replicas: [{ location: config.location }] } } }, opt));
      if (result.name !== name) return invalidResponse();
      return addVersion(id, payload, opt);
    },
    addVersion,
    async access(ref, opt = {}) {
      version(ref);
      const result = record(await request(`${ref}:access`, 'GET', undefined, opt));
      if (result.name !== ref) return invalidResponse();
      const payload = record(result.payload);
      const encoded = text(payload.data, 87384);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalidResponse();
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 65536 || encoded !== bytes.toString('base64') || String(payload.dataCrc32c) !== crc32c(bytes)) return invalidResponse();
      // El puerto guarda texto; UTF-8 roto no se convierte silenciosamente en otra credencial.
      const value = bytes.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(bytes)) return invalidResponse();
      return value;
    },
    async destroy(ref, opt = {}) {
      version(ref);
      try {
        if (await state(ref, opt) === 'DESTROYED') return;
        const response = record(await request(`${ref}:destroy`, 'POST', {}, opt));
        if (response.name !== ref || response.state !== 'DESTROYED') return invalidResponse();
      } catch (error) {
        if (error instanceof GoogleIntegrationError && error.code === 'GOOGLE_NOT_FOUND') return;
        // Otra instancia pudo destruir la misma versión después de nuestra lectura.
        if (error instanceof GoogleIntegrationError && error.status === 400 && await state(ref, opt) === 'DESTROYED') return;
        throw error;
      }
    },
    async deleteSecret(id, opt = {}) {
      const name = secret(id);
      try { await request(name, 'DELETE', undefined, opt); }
      catch (error) {
        if (error instanceof GoogleIntegrationError && error.code === 'GOOGLE_NOT_FOUND') return;
        throw error;
      }
    },
  };
}
