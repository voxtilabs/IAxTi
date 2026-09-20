const telemetry = require('../../dist');
telemetry.initObservability('integration-369');
const Sentry = require('@sentry/node');

(async () => {
  const resultados = await Promise.all(['uno', 'dos'].map((tenant) =>
    Sentry.withIsolationScope(async (scope) => {
      scope.setTag('test_tenant', tenant);
      return telemetry.conTrazaDelJob(undefined, `root-${tenant}`, {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, tenant === 'uno' ? 20 : 5));
        const carrier = telemetry.contextoDeTraza();
        await telemetry.conTrazaDelJob(carrier, `child-${tenant}`, {}, async () => {
          telemetry.captureError(new Error(`local-${tenant}`), { requestId: `req_${tenant}` });
        });
        return { tenant, carrier };
      });
    }),
  ));
  await telemetry.flushTelemetry();
  console.log(JSON.stringify(resultados));
  // El manejador de producción vacía el SDK OTLP antes de salir.
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) process.emit('SIGTERM');
  else process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
