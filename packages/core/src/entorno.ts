/**
 * Enteros que vienen del entorno, sin sorpresas (#241 y parientes).
 *
 * `Number(process.env.X ?? 120)` se lee bien y falla mal:
 *
 *   X="tres"  → NaN   → comparaciones falsas, fechas inválidas, listen(NaN)
 *   X=""      → 0     → y `??` NO lo atrapa: solo cubre null y undefined
 *
 * La cadena vacía es el caso que muerde, porque dejar una variable vacía en
 * el panel es la forma normal de "desactivarla". Y con `Number("") === 0` un
 * cero significa cosas muy distintas según dónde caiga:
 *
 *   PORT=""                      → listen(0) escucha en un puerto AL AZAR;
 *                                  el proxy apunta al 3000 y responde 404
 *   WHATSAPP_MSGS_PER_SECOND=""  → no sale ni un mensaje
 *   RATE_LIMIT_PER_MINUTE=""     → toda petición responde 429
 *   DB_CONNECT_TIMEOUT_MS=""     → para pg, 0 es SIN tope: se cuelga en vez
 *                                  de fallar
 *
 * Ninguno de esos se ve como "la variable está mal": se ven como que el
 * producto está roto, y cada uno manda a investigar a otra parte.
 *
 * Acá un valor inválido cae al por-defecto y LO DICE. Callarse sería repetir
 * el problema en otro lugar.
 */
export function enteroDeEntorno(
  nombre: string,
  pordefecto: number,
  opciones: { min?: number; env?: NodeJS.ProcessEnv } = {},
): number {
  const env = opciones.env ?? process.env;
  const min = opciones.min ?? 1;
  const crudo = env[nombre];
  // Ausente o en blanco: no está configurada, y eso no es un error.
  if (crudo === undefined || crudo.trim() === '') return pordefecto;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < min) {
    console.warn(
      `entorno: ${nombre}="${crudo}" no sirve (se esperaba un número ≥ ${min}). ` +
        `Se usa ${pordefecto}. Revísala donde se configura el ambiente.`,
    );
    return pordefecto;
  }
  return n;
}

/**
 * Textos que vienen del entorno, con la misma regla que los enteros (#575).
 *
 * `process.env.X ?? 'defecto'` se lee bien y falla mal, por el mismo motivo que
 * su hermano de arriba: **`??` solo atrapa `null` y `undefined`**. Una variable
 * dejada en blanco —que es la forma normal de «desactivarla» en un panel— pasa
 * como cadena vacía y el por-defecto no entra nunca.
 *
 * Y con un texto el daño es más silencioso que con un número, porque `''` casi
 * nunca explota: se propaga.
 *
 *   IAXTI_ENV=""         → el log dice «SIN AISLAMIENTO ()» y, peor, la
 *                          comprobación que decide compara contra 'production'
 *                          y nunca calza: el modo live de pagos se rechaza en
 *                          producción y los cobros se caen
 *   SENTRY_ENVIRONMENT="" → Sentry recibe environment:'' y las reglas de alerta
 *                          filtradas por 'production' no matchean NADA: los
 *                          errores llegan y nadie los ve
 *   PUBLIC_API_URL=""    → al proveedor de pagos se le manda
 *                          confirmUrl:'/webhooks/payments/x' — una ruta
 *                          relativa. El cliente paga, el webhook nunca llega y
 *                          el link queda «pending» para siempre
 *
 * Ninguno se ve como «la variable está mal»: se ven como que el producto está
 * roto, y cada uno manda a investigar a otra parte.
 */
export function textoDeEntorno(
  nombre: string,
  pordefecto: string,
  opciones: { env?: NodeJS.ProcessEnv } = {},
): string {
  const crudo = (opciones.env ?? process.env)[nombre];
  // Ausente o en blanco: no está configurada. No es un error y no se avisa —
  // avisar de lo normal es la forma más rápida de que nadie lea los avisos.
  if (crudo === undefined || crudo.trim() === '') return pordefecto;
  return crudo.trim();
}

/**
 * En qué ambiente corre esto, y avisa cuando no lo sabe (#575).
 *
 * `IAXTI_ENV` es distinta del resto: de ella cuelgan decisiones de plata y de
 * aislamiento —el modo live de los pagos, el environment de Sentry, la
 * comprobación de RLS— y caer al por-defecto EN SILENCIO es cómo un ambiente
 * mal configurado se hace pasar por desarrollo.
 *
 * Así que acá sí se avisa: una variable en blanco donde cuelgan esas decisiones
 * es una configuración incompleta, no una ausencia.
 */
export function entornoDesplegado(opciones: { env?: NodeJS.ProcessEnv } = {}): string {
  const env = opciones.env ?? process.env;
  const crudo = env.IAXTI_ENV;
  if (crudo !== undefined && crudo.trim() === '') {
    console.warn(
      'entorno: IAXTI_ENV está en BLANCO. De ella cuelgan el modo de los pagos, ' +
        'el environment de Sentry y la comprobación de aislamiento: se asume ' +
        '"development" y hay que revisarla donde se configura el ambiente.',
    );
  }
  return textoDeEntorno('IAXTI_ENV', 'development', { env });
}

/**
 * OJO con el por-defecto `development`, porque no es seguro en todas partes.
 *
 * Es lo más restrictivo donde la pregunta es «¿puedo cobrar de verdad?» o
 * «¿puedo saltarme la comprobación de RLS?»: ahí, no saber equivale a no.
 *
 * Pero es lo más PERMISIVO donde la pregunta es «¿puedo aceptar una petición
 * sin verificar el token?» — el fallback de `authz.guard.ts`, que existe para
 * el local sin Supabase cableado. Ahí asumir `development` abre la puerta.
 *
 * Por eso esa cerradura NO usa esto: distingue a mano entre la variable
 * ausente (nadie configuró nada: es el local) y la variable declarada en
 * blanco (alguien configuró el ambiente y se le quedó vacía: es un
 * despliegue, y no se abre). La dirección segura depende de quién pregunta,
 * así que la decide quien pregunta.
 */
/** ¿Es producción? La única pregunta que de verdad se hace sobre `IAXTI_ENV`. */
export function esProduccion(opciones: { env?: NodeJS.ProcessEnv } = {}): boolean {
  return entornoDesplegado(opciones) === 'production';
}
