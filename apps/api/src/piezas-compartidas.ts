import type { PoolClient } from 'pg';
import {
  activeAgent,
  conversationAnalysis,
  effectiveMode,
  modoConQuienLoPuso,
} from '@iaxti/module-agents';
import { limitesDelCanal } from '@iaxti/module-channels';
import { retentionCutoff } from '@iaxti/module-conversations';

/**
 * Las respuestas que sirven DOS puertas, escritas una vez (#761).
 *
 * ## Por qué existe este archivo
 *
 * El arranque agrupado nació rearmando a mano la respuesta de cada ruta que
 * agrupa, y ahí se rompió dos veces —las dos tirando la bandeja completa al
 * abrir una conversación:
 *
 *  · `limitesDeAdjunto` devolvía el arreglo pelado donde la ruta suelta devuelve
 *    `{ canal, limites }`. El chat hace `limitesDeAdjunto?.limites.flatMap(…)`,
 *    y un arreglo es **truthy**: el `?.` no corta, `.limites` queda `undefined`
 *    y `.flatMap` lanza DURANTE el render.
 *  · `analisis` venía anidado y renombrado (`{ analisis, modo }`) donde la ruta
 *    suelta devuelve el DTO plano (`{ …analisis, mode, marcaManual }`), y de
 *    paso perdía `marcaManual` — el dato de #697 que dice QUIÉN puso el piloto
 *    automático, que es la decisión más delicada del producto.
 *
 * Lo que las dos tienen en común no es el descuido: es que había **dos sitios
 * que arman la misma respuesta**. Mientras sean dos, se separan; el typecheck no
 * ayuda porque el front declara esos tipos a mano, y una prueba del servidor que
 * afirme la forma nueva la congela en vez de compararla con la vieja.
 *
 * Así que la respuesta se arma UNA vez y las dos puertas la llaman. Si alguna
 * vez el arranque necesita una forma distinta de la ruta suelta, eso es un
 * cambio de contrato y se decide a propósito, no por copiar mal.
 */

/** Lo que puede adjuntar una conversación, igual por las dos puertas (#560). */
export function limitesDeAdjuntoDe(canal: string) {
  return {
    canal,
    limites: limitesDelCanal(canal).map((l) => ({
      clase: l.clase,
      nombre: l.nombre,
      maxBytes: l.maxBytes,
      tipos: l.tipos,
    })),
  };
}

/**
 * Resumen, intención, calificación, modo del copiloto y quién lo puso.
 *
 * PLANO y con `mode` en inglés, porque es el contrato que la ficha ya lee. Y con
 * `marcaManual`, que es lo que se había perdido: dejar que la IA conteste sola a
 * un cliente es la decisión más delicada del producto, y quien abre la
 * conversación después tiene que ver quién la tomó (#697).
 */
export async function analisisDeConversacion(
  c: PoolClient,
  tenantId: string,
  conversationId: string,
) {
  const analisis = await conversationAnalysis(c, tenantId, conversationId);
  const agent = await activeAgent(c, tenantId);
  const mode = agent ? await effectiveMode(c, agent, tenantId, conversationId) : 'off';
  const marcaManual = await modoConQuienLoPuso(c, tenantId, conversationId);
  return { ...analisis, mode, marcaManual };
}

/**
 * La retención vigente, con las fechas ya en 'AAAA-MM-DD'.
 *
 * El `slice(0, 10)` no es cosmético: `retentionCutoff` devuelve `Date`, y un
 * `Date` que pasa por `JSON.stringify` sale como `"2026-10-10T13:22:33.123Z"`.
 * Rearmar esto en el arranque sin la conversión daba DOS contratos para el mismo
 * dato —24 caracteres por una puerta y 10 por la otra— y quien pinte la fecha
 * cortando los primeros diez caracteres acierta por casualidad hasta que alguien
 * la formatee de verdad.
 */
export async function retencionVigente(c: PoolClient, tenantId: string) {
  const r = await retentionCutoff(c, tenantId);
  return {
    months: r.months,
    cutoff: r.cutoff ? r.cutoff.toISOString().slice(0, 10) : null,
    deferredUntil: r.deferredUntil ? r.deferredUntil.toISOString().slice(0, 10) : null,
  };
}
