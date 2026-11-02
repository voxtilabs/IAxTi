import type { Span } from '@opentelemetry/api';
import { textoDeLog } from './redaccion-log';

/**
 * La consulta de una URL no sale de este proceso (#1170).
 *
 * ## El defecto
 *
 * `textoDeLog` redacta lo que va a `console` y de ahí a OTLP, y la pieza que
 * consulta el nombre de perfil de WhatsApp cuida el motivo que registra
 * («tampoco la URL, que lleva el teléfono»). Pero la URL salía igual del
 * proceso por DOS caminos que nadie revisó, los dos automáticos:
 *
 *  1. `getNodeAutoInstrumentations()` incluye
 *     `@opentelemetry/instrumentation-undici`, que es el que instrumenta el
 *     `fetch` global de Node. Escribe `url.full` con la URL COMPLETA y
 *     `url.query` con la consulta entera, y el sampler por defecto exporta el
 *     100 %. O sea: `url.full = …/contacts?search=56912345678` viajando a
 *     Grafana Cloud, un número de cliente por mensaje.
 *  2. `Sentry.init` pasa `integrations: [httpIntegration({spans:false})]`, que
 *     se SUMA a las de fábrica: `nativeNodeFetchIntegration` sigue viva y su
 *     breadcrumb guarda `data['http.query'] = parsedUrl.search`. El próximo
 *     error que ese proceso reporte llega con el número adentro.
 *
 * Ninguno de los dos pasa por `textoDeLog`, porque no son logs.
 *
 * ## Por qué se corta acá y no en el llamador
 *
 * Porque no es un problema del llamador: NINGUNA consulta de NINGÚN proveedor
 * tiene por qué quedar en un atributo de span ni en un breadcrumb. El valor de
 * diagnóstico de una traza de salida está en el método, el host y la ruta —y
 * esos quedan—; la consulta es donde viajan los datos. Arreglarlo en el borde
 * de salida lo arregla para el próximo llamador también, que es el que no va a
 * acordarse de esto.
 *
 * `.claude/rules/seguridad.md`: «PII: minimizar en logs; redactar antes de …
 * cualquier proveedor».
 */

/** La URL sin consulta ni fragmento. Lo que no se puede parsear se redacta. */
export function urlSinConsulta(url: unknown): string {
  if (typeof url !== 'string') return '[REDACTADO]';
  const corte = url.search(/[?#]/);
  const limpia = corte < 0 ? url : url.slice(0, corte);
  // `textoDeLog` igual, por si la URL trae credenciales en el `userinfo`
  // (`https://user:clave@host/...`), que es la otra forma de meter un secreto
  // en una URL.
  return textoDeLog(limpia);
}

/**
 * La configuración de `@opentelemetry/instrumentation-undici` que deja el span
 * sin la consulta.
 *
 * Se pisa el atributo en `requestHook` y no se desactiva la instrumentación:
 * saber que salió un `GET` a `api.zavu.dev/v1/contacts` y cuánto tardó es
 * justo lo que hace falta para diagnosticar; el número de teléfono no.
 */
export const instrumentacionUndiciSinConsulta = {
  requestHook: (span: Span, request: { origin?: string; path?: string }) => {
    const completa = `${request?.origin ?? ''}${request?.path ?? ''}`;
    span.setAttribute('url.full', urlSinConsulta(completa));
    // `url.query` existe para llevar la consulta: no hay versión limpia de
    // este atributo, se vacía.
    span.setAttribute('url.query', '');
  },
};

/** El breadcrumb de un pedido HTTP, sin la consulta. */
export function breadcrumbSinConsulta<T extends { data?: Record<string, unknown> } | null>(
  breadcrumb: T,
): T {
  const data = breadcrumb?.data;
  if (!data) return breadcrumb;
  if ('url' in data) data.url = urlSinConsulta(data.url);
  // Se BORRAN, no se redactan: una clave que existe con `[REDACTADO]` invita a
  // que alguien «arregle» la redacción para ver el valor.
  delete data['http.query'];
  delete data['http.fragment'];
  return breadcrumb;
}
