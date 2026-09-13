// Next.js carga este archivo al arrancar el server (Node runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initObservability } = await import('@iaxti/telemetry');
    initObservability('web');
  }
}
