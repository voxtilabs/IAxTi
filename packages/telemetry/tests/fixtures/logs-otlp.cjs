const telemetry = require('../../dist');
const api = require('@opentelemetry/api');
telemetry.initObservability('logs-17');
// Reenvolver no duplica ni la línea local ni la emisión.
telemetry.activarLogsEstructurados('logs-17');
(async () => {
  if (process.argv[2] === 'saturacion') {
    for (let i = 0; i < 700; i++) console.log(`lote-${i}`);
  } else {
    await Promise.all(['uno', 'dos'].map((tenant) => telemetry.conContextoDeLog({ tenantId: tenant, requestId: `req_${tenant}` }, () =>
      api.trace.getTracer('fixture-17').startActiveSpan(`request-${tenant}`, async (span) => {
        const carrier = telemetry.contextoDeTraza();
        console.log(`request-${tenant}`);
        await telemetry.conTrazaDelJob(carrier, `job-${tenant}`, {}, async () => {
          await Promise.resolve();
          const error = new Error('timeout ana@example.invalid Bearer ficticio-bearer password=ficticia-clave https://host.invalid/path?token=ficticio-query');
          error.cause = { secret: 'ficticia-cause' };
          console.error(`job-${tenant}`, error, {
            meta: { password: 'ficticia-meta', body: 'conversación privada' },
            config: { data: JSON.stringify({ messages: [{ content: 'contenido privado Axios' }] }), headers: { Authorization: 'Bearer ficticio-axios' } },
            request: { raw: 'solicitud privada Axios' }, response: { status: 502, data: 'respuesta privada Axios' },
            cause: { payload: 'prompt privado Axios' },
          });
        });
        span.end();
      })
    )));
  }
  telemetry.alApagar('última pieza', () => console.log('drenaje-final'));
  await Promise.all([telemetry.apagarOrdenado('test'), telemetry.apagarOrdenado('test repetido')]);
  // Sin process.exit: las pruebas detectan conexiones/timers que impidan salir.
})().catch(() => { process.exitCode = 1; });
