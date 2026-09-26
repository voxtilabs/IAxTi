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
  return `${tenantId}/${conversationId}/${Date.now().toString(36)}-${nombreSeguro(filename)}`;
}

/**
 * La llave de un documento del conocimiento (#522).
 *
 * Mismo prefijo por tenant que los adjuntos —de ahí cuelga el aislamiento: la
 * ruta de bajada solo firma llaves que empiecen con el tenant de quien pide— y
 * una carpeta propia para no mezclar el conocimiento del negocio con los
 * archivos de una conversación.
 */
export function knowledgeKey(tenantId: string, filename: string): string {
  return `${tenantId}/conocimiento/${Date.now().toString(36)}-${nombreSeguro(filename)}`;
}

/**
 * El nombre que llega del navegador no se usa tal cual: se le sacan los
 * acentos, se reemplaza todo lo que no sea seguro en una ruta, y se recorta.
 * Sin esto, un archivo llamado `../../otro-tenant/algo.pdf` sería una llave
 * fuera del prefijo del negocio.
 */
function nombreSeguro(filename: string): string {
  return filename.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
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
 * El núcleo de SigV4, separado de cómo armamos la ruta. Está aparte para
 * poder verificarlo contra el VECTOR PUBLICADO por AWS: una firma que solo
 * se compara consigo misma puede estar mal y pasar todos los tests, y el
 * error aparece recién el día que un cliente manda una foto.
 */
export function firmaPresignada(input: {
  method: 'GET' | 'PUT' | 'DELETE';
  host: string;
  /** Ruta canónica YA codificada, con su `/` inicial. */
  canonicalUri: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** `AAAAMMDDTHHMMSSZ`. */
  amzDate: string;
  expiresSeconds: number;
}): { canonicalQuery: string; signature: string } {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', input.amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  // SigV4 exige el query ORDENADO por nombre de parámetro ya codificado.
  const canonicalQuery = query
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQuery,
    `host:${input.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { canonicalQuery, signature };
}

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
  const url = new URL(config.endpoint);
  // R2 en estilo path: el bucket va en la ruta, no en el host.
  const canonicalUri = `/${config.bucket}/${key.split('/').map(encodeRfc3986).join('/')}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const { canonicalQuery, signature } = firmaPresignada({
    method,
    host: url.host,
    canonicalUri,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region ?? 'auto',
    amzDate,
    expiresSeconds,
  });

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
