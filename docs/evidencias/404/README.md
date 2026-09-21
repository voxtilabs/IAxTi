# Pulso Vivo · #404

Capturas de Chromium del build de producción, con datos sintéticos.
`recorrido-visual.json` registra 31 rutas (29 del cliente y 2 de administración)
en día/noche y a 1440/360 px: 124 revisiones sin excepciones JavaScript ni
desbordes horizontales. Se incluyeron ficha de contacto, invitación y webchat.

La referencia VOXIA 2 se sirvió desde su repositorio local, sin conectar su
API. Las comparaciones completa y de detalle reúnen referencia e implementación
en una misma imagen; no son propuestas generadas ni capturas retocadas.

El recorrido visual usa respuestas sintéticas y no prueba proveedores. La
regresión funcional se ejecuta por separado contra la API, PostgreSQL y Redis
reales de desarrollo, mediante `apps/web/e2e/run-e2e.mjs`. El acceso por código
simula la respuesta OTP para evitar enviar correos durante las pruebas.

Validación reproducible, con PostgreSQL/Redis exclusivos para pruebas:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm depcruise
pnpm turbo build --concurrency=1
pnpm turbo typecheck --concurrency=1
# Exportar DATABASE_URL y REDIS_URL del entorno local de pruebas antes de seguir.
pnpm turbo test --concurrency=1
pnpm --filter @iaxti/db exec vitest run
pnpm --filter @iaxti/core exec vitest run
node apps/web/e2e/run-e2e.mjs
```

Build y typecheck se ejecutan en secuencia: ambos usan `.next/types`.
Las capturas opcionales del shell se activan con `CAPTURAS=1`; el E2E de
densidad también deja medidas e imágenes a 360/1280 px en día/noche.

Decisión de diseño: [ADR-0021](../../adr/0021-pulso-vivo-identidad-y-profundidad.md).
Revisión y límites: [design-qa.md](../../../design-qa.md).
