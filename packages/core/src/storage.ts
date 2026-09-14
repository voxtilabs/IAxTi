import { createHash, createHmac } from 'node:crypto';

/**
 * Adjuntos en R2 (SPEC §36/§40): en Postgres solo metadata; los bytes van al
 * bucket con PREFIJO POR TENANT y el navegador sube/baja directo con URLs
 * prefirmadas (SigV4 query, UNSIGNED-PAYLOAD). Sin SDK: son ~60 líneas de
 * crypto estándar y ningún servicio carga aws-sdk por esto.
 */
export interface StorageConfig {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // R2 usa "auto"
}

export function storageFromEnv(): StorageConfig | null {
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_ADJUNTOS } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_ADJUNTOS) return null;
  return {
    endpoint: R2_ENDPOINT,
    bucket: R2_BUCKET_ADJUNTOS,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

/** La llave SIEMPRE nace bajo el tenant: nadie firma fuera de su prefijo. */
export function attachmentKey(tenantId: string, conversationId: string, filename: string): string {
  const limpio = filename.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return `${tenantId}/${conversationId}/${Date.now().toString(36)}-${limpio}`;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function sha256hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

const encodeRfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * URL prefirmada (GET para bajar, PUT para subir), validez en segundos.
 * `now` se inyecta en tests para firmas deterministas.
 */
export function presignUrl(
  config: StorageConfig,
  method: 'GET' | 'PUT' | 'DELETE',
  key: string,
  expiresSeconds = 900,
  now: Date = new Date(),
): string {
  const region = config.region ?? 'auto';
  const url = new URL(config.endpoint);
  const host = url.host;
  const canonicalUri = `/${config.bucket}/${key.split('/').map(encodeRfc3986).join('/')}`;

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
