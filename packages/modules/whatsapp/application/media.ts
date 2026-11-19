import { attachmentKey, presignPutUrl } from '@iaxti/core';
import type { StorageConfig } from '@iaxti/core';
import { ErrorPermanente } from './outbound';

// Adjuntos de WhatsApp (#42, SPEC §11/§36): Meta los EXPIRA — se descargan
// al llegar y van a R2 con prefijo por tenant. En Postgres, solo la llave.

export interface AdjuntoEntrante {
  url?: string;
  contentType?: string;
  name?: string;
}

export interface AdjuntoGuardado {
  key: string;
  contentType: string;
  name: string;
}

/**
 * Cuánto se espera y cuánto se acepta de un adjunto (#1275).
 *
 * Antes no había ninguno de los dos. Y los tres hechos juntos lo volvían un
 * bloqueo del despliegue entero: la descarga va a memoria, ocurre DENTRO de
 * la transacción del camino de entrada, y la cola de entrada corre de a uno.
 * Mientras un archivo viajaba, no entraba nada: ni los mensajes de los otros
 * negocios, ni los acuses, ni los avisos de pago. Y una conexión colgada no
 * la cortaba nadie.
 *
 * El tope sale de `LIMITES_CONSERVADORES`, que el repo ya calculó en 8 MB con
 * su razonamiento escrito. Pasarse no pierde el mensaje: el camino de entrada
 * ya guarda el texto con la metadata original cuando el adjunto falla, y la
 * bandeja lo dice en castellano.
 */
const PLAZO_DE_DESCARGA_MS = 20_000;
const TOPE_DE_DESCARGA = 8 * 1024 * 1024;

/**
 * Si la llave del proveedor puede ir a esta URL (#1335).
 *
 * Solo por HTTPS y solo a un host del dominio del proveedor: el del API o un
 * subdominio suyo (`zernio.com`, `cdn.zernio.com`). No se sabe desde el código
 * en qué host sirve el proveedor sus adjuntos, así que se admite el dominio
 * entero en vez de adivinar un host.
 *
 * Por NOMBRE DE HOST y con límite de punto, nunca `startsWith` sobre el texto:
 * `https://zernio.com.atacante.com` empieza igual, y `malozernio.com` termina
 * igual sin el punto.
 *
 * El dominio es el host del API sin su primera etiqueta cuando tiene tres o
 * más (`api.zernio.com` → `zernio.com`), y el host tal cual cuando tiene dos
 * (`zernio.com`), para no terminar confiando en `com`. No contempla sufijos
 * públicos de dos niveles (`.co.uk`): ningún proveedor nuestro los usa, y si
 * uno los usara esto confiaría de menos, no de más.
 */
export function llevaCredencial(url: string, apiBase: string): boolean {
  let destino: URL;
  let api: URL;
  try {
    destino = new URL(url);
    api = new URL(apiBase);
  } catch {
    return false;
  }
  if (destino.protocol !== 'https:') return false;
  const etiquetas = api.hostname.split('.');
  const dominio = etiquetas.length >= 3 ? etiquetas.slice(1).join('.') : api.hostname;
  const host = destino.hostname;
  return host === dominio || host.endsWith(`.${dominio}`);
}

/**
 * Config de la descarga. La `apiBase` la trae quien llama — es la del
 * proveedor DE LA CUENTA, no un default de archivo (#1339): cada cuenta sabe
 * con quién habla.
 */
export interface ConfigDeMedia {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export async function fetchMediaBytes(
  url: string,
  apiKey: string,
  /**
   * `maxBytes` y `timeoutMs` se pueden pasar para poder MEDIRLOS sin reservar
   * ocho megas en una prueba. No es un adorno: la primera versión de estas
   * pruebas fabricaba búfers del tamaño real y el reportero de vitest se
   * ahogaba con `Timeout calling "onTaskUpdate"` — los tests corrían y sus
   * resultados se perdían, que es peor que no tenerlos.
   */
  config: ConfigDeMedia & { maxBytes?: number; timeoutMs?: number; apiBase: string } = { apiBase: '' },
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const tope = config.maxBytes ?? TOPE_DE_DESCARGA;
  const enMB = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
  const fetchImpl = config.fetchImpl ?? fetch;
  // La llave de la cuenta viaja SOLO al dominio del proveedor (#1335). La URL
  // sale del payload del webhook: la firma prueba que el payload es del
  // proveedor, no que cada URL de adentro apunte a él.
  const conLlave = llevaCredencial(url, config.apiBase);
  const bin = await fetchImpl(url, {
    ...(conLlave ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    signal: AbortSignal.timeout(config.timeoutMs ?? PLAZO_DE_DESCARGA_MS),
  });
  if (!bin.ok) throw new Error(`No pudimos bajar el adjunto: HTTP ${bin.status}`);
  // El tamaño declarado, cuando viene: ahorra bajar lo que de todas formas se
  // va a descartar.
  const declarado = Number(bin.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declarado) && declarado > tope) {
    // Permanente: un archivo no se achica porque lo reintentemos. El mensaje
    // entra igual con su metadata, que es lo que ya hace el camino de entrada.
    throw new ErrorPermanente(
      `Ese archivo pesa ${enMB(declarado)} MB y el máximo son ${enMB(tope)} MB. Pídeselo más liviano.`,
      `content-length ${declarado} sobre el tope ${tope}.`,
    );
  }
  const bytes = await bin.arrayBuffer();
  // Y el real, porque `content-length` puede no venir o mentir. Acá ya se
  // gastó la memoria, pero no se gasta el viaje a R2 ni la fila.
  if (bytes.byteLength > tope) {
    throw new ErrorPermanente(
      `Ese archivo pesa ${enMB(bytes.byteLength)} MB y el máximo son ${enMB(tope)} MB. Pídeselo más liviano.`,
      `${bytes.byteLength} bytes sobre el tope ${tope}; el proveedor no declaró content-length.`,
    );
  }
  return {
    bytes,
    contentType: bin.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export async function downloadAttachmentsToR2(
  input: {
    tenantId: string;
    conversationId: string;
    attachments: AdjuntoEntrante[];
    apiKey: string;
    storage: StorageConfig;
  },
  config: ConfigDeMedia & { apiBase: string },
): Promise<AdjuntoGuardado[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const guardados: AdjuntoGuardado[] = [];
  for (const adjunto of input.attachments) {
    if (!adjunto.url) continue;
    const { bytes, contentType } = await fetchMediaBytes(adjunto.url, input.apiKey, config);
    const name = adjunto.name ?? adjunto.url.split('/').pop() ?? 'adjunto';
    const key = attachmentKey(input.tenantId, input.conversationId, name);
    const tipo = adjunto.contentType ?? contentType;
    // Acá la URL no sale de este proceso —bajamos los bytes y los subimos
    // nosotros—, así que el riesgo del permiso en blanco es bajo. Se firma tipo
    // y tamaño igual, por dos razones: tenemos los bytes en la mano, así que
    // el largo exacto es gratis; y que las TRES puertas que firman un PUT lo
    // hagan del mismo modo es lo que evita que la próxima se escriba con la
    // insegura, copiando de la que quedó.
    const subida = await fetchImpl(
      presignPutUrl(input.storage, key, { contentType: tipo, contentLength: bytes.byteLength }),
      {
        method: 'PUT',
        headers: { 'Content-Type': tipo, 'Content-Length': String(bytes.byteLength) },
        body: bytes,
      },
    );
    if (!subida.ok) throw new Error(`No pudimos guardar el adjunto en el almacenamiento: HTTP ${subida.status}`);
    guardados.push({ key, contentType: tipo, name });
  }
  return guardados;
}
