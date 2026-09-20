# SDK de IAxTi

## Onboarding

`getOnboarding` consulta el progreso verificado del negocio con la sesión y el
tenant actuales. Las rutas de los pasos vienen del servidor; no se reconstruyen
en la interfaz. Un 403 oculta el avance y otros fallos permiten reintentar.

Para regenerar la operación desde `/docs-json` de la API local:

```sh
node packages/sdk/scripts/generate-onboarding.mjs /ruta/al/openapi.json
```

El método y la ruta se generan; la interfaz de respuesta refleja el contrato
existente. `apps/api/tests/onboarding-sdk.test.ts` detecta diferencias con OpenAPI.

## Campañas

El flujo de campañas usa `campaignClient` desde el frontend. El SDK incorpora
la sesión, el tenant, las llaves de idempotencia y el formato de error de la
plataforma. Los componentes no construyen URLs de campañas.

Los métodos y rutas de `campaign-routes.generated.ts` se generan desde el
OpenAPI publicado por la API. Para actualizarlo, guarda `/docs-json` de la API
local y ejecuta desde la raíz:

```sh
node packages/sdk/scripts/generate-campaigns.mjs /ruta/al/openapi.json
pnpm --filter @iaxti/sdk build
```

Las interfaces de respuesta están tipadas en `campaigns.ts`, de acuerdo con los
contratos existentes. `apps/api/tests/campanas-sdk.test.ts` compara cada operación
generada con el OpenAPI real; el E2E de campañas recorre las respuestas reales
del servidor usando este cliente.
