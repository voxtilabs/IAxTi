import { createHmac, timingSafeEqual } from 'node:crypto';
import { textoDeEntorno } from '@iaxti/core';
import { ErrorPermanente } from './outbound';

/**
 * El núcleo de seguridad del adaptador de Zernio (ADR-0032, #1317).
 *
 * Vive aparte del adaptador porque son las dos piezas donde un error no se ve
 * en una prueba de punta a punta y se paga en datos de clientes: verificar que
 * un webhook es de Zernio, y que cada petición salga con la llave de SU
 * cuenta. Lo demás del adaptador es traducir formas.
 */

export const ZERNIO_API_BASE_DEFAULT = 'https://zernio.com/api/v1';

export function baseDeZernio(apiBase?: string): string {
  // Mismo cuidado que `baseDeZavu` (#575): `ZERNIO_API_BASE=""` no puede ganar
  // y dejar todas las llamadas contra la cadena vacía.
  return apiBase?.trim() || textoDeEntorno('ZERNIO_API_BASE', ZERNIO_API_BASE_DEFAULT);
}

/**
 * La firma de un webhook de Zernio.
 *
 * `X-Zernio-Signature`: HMAC-SHA256 en hex, sin prefijo, del cuerpo CRUDO byte
 * a byte. Sin timestamp: la protección contra repetición es la deduplicación
 * por `X-Zernio-Event-Id`, que el camino de entrada ya hace por id.
 *
 * Tres decisiones que se toman acá y no en otro lado, y por qué:
 *
 * 1. **NO se acepta `X-Late-Signature`.** Zernio se llamaba Late y todavía
 *    manda copias `X-Late-*`, que su spec (v1.527) declara heredadas y «se
 *    quitarán en una versión mayor». ZernFlow, hecho por el propio Zernio,
 *    verifica con la vieja: copiarlo era un apagón con fecha. Aceptar las dos
 *    no suma seguridad y deja una puerta que nadie mira.
 * 2. **Sin secreto o sin firma, se rechaza.** En Zernio la firma es OPCIONAL
 *    —solo existe si la suscripción tiene secreto—. ZernFlow deja pasar lo que
 *    llega sin secreto; Vocero lo deja pasar a propósito en tres casos. En una
 *    instalación de un solo negocio es defendible. En IAxTi, multi-tenant, es
 *    la puerta para meter mensajes en el tenant de otro cliente, y que el
 *    agente les conteste por la cuenta real.
 * 3. **Comparación de tiempo constante**, y el largo se compara antes porque
 *    `timingSafeEqual` tira con largos distintos.
 */
export function verifyZernioSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
): boolean {
  if (!secret) return false;
  const crudo = cabecera(headers, 'x-zernio-signature');
  if (!crudo) return false;
  const recibida = crudo.trim().toLowerCase();
  // Hex de 64: cualquier otra forma no es una firma de Zernio, y rechazarla
  // antes evita que `Buffer.from` interprete basura.
  if (!/^[0-9a-f]{64}$/.test(recibida)) return false;
  const esperada = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(esperada, 'hex'), Buffer.from(recibida, 'hex'));
}

/** Las cabeceras de Node llegan en minúscula, pero un test o un proxy puede no. */
function cabecera(
  headers: Record<string, string | string[] | undefined>,
  nombre: string,
): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== nombre) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export interface ConfigDeZernio {
  apiKey: string;
  apiBase: string;
  fetchImpl: typeof fetch;
}

/**
 * Una petición a Zernio con la llave de UNA cuenta.
 *
 * Por qué no el SDK `@zernio/node`: registra su interceptor de autenticación
 * sobre un cliente GLOBAL al módulo, y cada `new Zernio({ apiKey })` apila
 * otro; la última llave construida gana para todas las peticiones en vuelo
 * (ZernFlow #18, «no clean workaround»). Con dos tenants mandando a la vez,
 * los mensajes de A salen con la cuenta de B. Acá la llave viaja en cada
 * llamada y no existe estado compartido entre cuentas.
 *
 * Devuelve el cuerpo ya parseado. Los errores se clasifican en el adaptador,
 * que es el que sabe qué significa cada código para cada operación; acá solo
 * se garantiza que el error lleva el estado HTTP y el cuerpo para el log.
 */
export async function llamarAZernio<T>(
  cfg: ConfigDeZernio,
  ruta: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.apiKey}`,
    accept: 'application/json',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  const r = await cfg.fetchImpl(`${cfg.apiBase}${ruta}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const texto = await r.text();
  if (!r.ok) throw new ErrorDeZernio(r.status, texto);
  return (texto ? JSON.parse(texto) : {}) as T;
}

/** Un error de Zernio con lo que hace falta para clasificarlo. */
export class ErrorDeZernio extends Error {
  readonly code: string | undefined;
  constructor(
    readonly status: number,
    readonly cuerpo: string,
  ) {
    super(`Zernio respondió ${status}`);
    this.name = 'ErrorDeZernio';
    // El spec promete un `code` legible por máquina en el JSON de error.
    try {
      this.code = (JSON.parse(cuerpo) as { code?: string }).code;
    } catch {
      this.code = undefined;
    }
  }
}

/**
 * La llave de la cuenta, por referencia: la cuenta guarda el NOMBRE de la
 * variable, nunca el valor (mismo contrato que Zavu, SPEC §17).
 */
export function llaveDeLaCuenta(credentialRef: string | null, cuentaId: string): string {
  const apiKey = credentialRef ? process.env[credentialRef] : undefined;
  if (!apiKey) {
    throw new ErrorPermanente(
      'Este canal no tiene su credencial configurada. Un administrador tiene que reconectarlo en Canales.',
      `La cuenta ${cuentaId} no tiene su llave de Zernio en el entorno.`,
    );
  }
  return apiKey;
}
