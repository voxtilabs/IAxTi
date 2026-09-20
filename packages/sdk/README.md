# SDK de IAxTi

`getOnboarding` consulta el progreso verificado del negocio con la sesión y el
tenant actuales. Las rutas de los pasos vienen del servidor; no se reconstruyen
en la interfaz. Un 403 oculta el avance y otros fallos permiten reintentar.

Para regenerar la operación desde `/docs-json` de la API local:

```sh
node packages/sdk/scripts/generate-onboarding.mjs /ruta/al/openapi.json
```

El método y la ruta se generan; la interfaz de respuesta refleja el contrato
existente. `apps/api/tests/onboarding-sdk.test.ts` detecta diferencias con OpenAPI.
