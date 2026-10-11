// Next.js carga este archivo al arrancar el server (Node runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initObservability } = await import('@iaxti/telemetry');
    initObservability('web');
  }
}

/**
 * Los errores del SERVIDOR llegan a Sentry (#17).
 *
 * Next 15 llama a este gancho con los fallos de renderizado, Server Actions y
 * route handlers. Sin él, `Sentry.init` corría igual y esos errores se quedaban
 * en el log del contenedor: la pantalla que se cae del lado servidor no
 * generaba ningún aviso, mientras los errores del navegador sí. Eso da la
 * impresión de que el front no falla.
 *
 * La implementación vive en `@iaxti/telemetry` porque son dos apps y una sola
 * política —`admin` tiene este mismo archivo—, y dos copias de una política se
 * separan en el primer cambio.
 */
export async function onRequestError(
  ...args: Parameters<typeof import('@iaxti/telemetry').errorDeRequestDeNext>
) {
  const { errorDeRequestDeNext } = await import('@iaxti/telemetry');
  errorDeRequestDeNext(...args);
}
