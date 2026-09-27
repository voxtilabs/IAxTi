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
  /**
   * Cabeceras que ADEMÁS de `host` entran en la firma. Todo lo que se firma
   * queda amarrado: si el cliente manda otro valor, R2 responde 403 porque la
   * firma no le cuadra. Es la única forma de que una URL prefirmada imponga
   * algo sobre el contenido — sin esto la URL vale para subir cualquier cosa.
   */
  cabecerasFirmadas?: Record<string, string>;
}): { canonicalQuery: string; signature: string; signedHeaders: string } {
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;

  // `host` siempre; lo demás, en minúscula y ordenado, como manda SigV4.
  const cabeceras = new Map<string, string>([['host', input.host]]);
  for (const [nombre, valor] of Object.entries(input.cabecerasFirmadas ?? {})) {
    if (valor === undefined || valor === null) continue;
    cabeceras.set(nombre.toLowerCase().trim(), String(valor).trim());
  }
  const nombres = [...cabeceras.keys()].sort();
  const signedHeaders = nombres.join(';');
  const canonicalHeaders = nombres.map((n) => `${n}:${cabeceras.get(n)}\n`).join('');

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', input.amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
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
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { canonicalQuery, signature, signedHeaders };
}

/**
 * URL prefirmada (GET para bajar, PUT para subir), validez en segundos.
 * `now` se inyecta en tests para firmas deterministas.
 *
 * OJO con el PUT sin `cabecerasFirmadas`: firma solo `host`, así que la URL
 * autoriza a subir CUALQUIER contenido de CUALQUIER tamaño a esa llave. Toda
 * validación de tipo o de peso que se haga antes de firmar es decorativa —
 * quien tenga la URL sube lo que quiera y el tráfico lo pagamos nosotros.
 * Para subidas, usa `presignPutUrl`, que sí amarra tipo y tamaño.
 */
export function presignUrl(
  config: StorageConfig,
  method: 'GET' | 'PUT' | 'DELETE',
  key: string,
  expiresSeconds = 900,
  now: Date = new Date(),
  cabecerasFirmadas?: Record<string, string>,
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
    cabecerasFirmadas,
  });

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Lo que una URL de subida tiene que dejar amarrado antes de existir. */
export interface LimitesSubida {
  /** El `Content-Type` EXACTO que el cliente tendrá que mandar. */
  contentType: string;
  /** El tamaño EXACTO en bytes que el cliente tendrá que mandar. */
  contentLength: number;
  expiresSeconds?: number;
  /** Se inyecta en tests para firmas deterministas. */
  now?: Date;
}

/**
 * URL prefirmada para SUBIR, con el tipo y el tamaño dentro de la firma.
 *
 * Por qué existe aparte de `presignUrl`: una URL prefirmada de PUT que solo
 * firma `host` es un permiso en blanco sobre esa llave. R2 no sabe nada del
 * límite de 10 MB ni del "solo PDF" que revisamos antes de firmar: eso vive
 * en nuestro proceso y muere ahí. Con la URL en la mano se sube un archivo de
 * 5 GB, y el almacenamiento y el egreso los paga la cuenta, no quien subió.
 *
 * Firmando `content-type` y `content-length`, el que sube QUEDA OBLIGADO a
 * mandar exactamente esos valores: cualquier otro cambia la firma canónica y
 * R2 responde 403. Los límites dejan de ser un adorno del servidor y pasan a
 * estar en el papel que el cliente presenta.
 *
 * Límite conocido, y no es un olvido: SigV4 prefirmado ampara un tamaño
 * EXACTO, no un rango. `content-length-range` existe solo en la política de
 * un POST de formulario, que es otro flujo de subida. Por eso quien pide la
 * URL tiene que declarar el tamaño del archivo, y el tamaño declarado es el
 * que se firma.
 */
export function presignPutUrl(config: StorageConfig, key: string, limites: LimitesSubida): string {
  if (!limites.contentType?.trim()) {
    throw new Error('Para firmar una subida hay que decir el tipo de archivo (content-type).');
  }
  if (!Number.isSafeInteger(limites.contentLength) || limites.contentLength <= 0) {
    throw new Error('Para firmar una subida hay que decir el tamaño del archivo en bytes.');
  }
  return presignUrl(
    config,
    'PUT',
    key,
    limites.expiresSeconds ?? 900,
    limites.now ?? new Date(),
    {
      'content-type': limites.contentType.trim(),
      'content-length': String(limites.contentLength),
    },
  );
}

/**
 * Borrar objetos del bucket de verdad.
 *
 * Es un puerto y no una función suelta para que los casos de uso que borran
 * por ley (supresión del titular, retención, sacar un documento del
 * conocimiento) puedan probarse sin red y, sobre todo, para que ninguno
 * pueda "borrar" simplemente juntando llaves en una lista.
 */
export interface AlmacenObjetos {
  /** Borra las llaves dadas. Idempotente: un 404 ya es borrado. */
  borrar(keys: string[]): Promise<{ borradas: string[]; fallidas: string[] }>;
}

/**
 * El almacén real, o `null` si este ambiente no tiene R2 configurado
 * (variables `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
 * `R2_BUCKET_ADJUNTOS`). Devuelve `null` en vez de lanzar para que quien
 * llama decida: hay borrados que pueden esperar y otros que NO se pueden
 * reportar como hechos si no ocurrieron.
 */
export function almacenR2(
  config: StorageConfig | null = storageFromEnv(),
  fetcher: typeof fetch = fetch,
): AlmacenObjetos | null {
  if (!config) return null;
  return {
    async borrar(keys: string[]) {
      const borradas: string[] = [];
      const fallidas: string[] = [];
      for (const key of [...new Set(keys)]) {
        try {
          const r = await fetcher(presignUrl(config, 'DELETE', key), { method: 'DELETE' });
          // El 404 cuenta como borrado: el objeto ya no está, que es lo que
          // se pedía, y así reintentar una supresión a medio camino es seguro.
          if (r.ok || r.status === 404) borradas.push(key);
          else fallidas.push(key);
        } catch {
          fallidas.push(key);
        }
      }
      return { borradas, fallidas };
    },
  };
}
