# SDK de IAxTi

`crmClient` concentra las operaciones de listas y etiquetado de las tablas de
contactos y oportunidades. Envía sesión, tenant, filtros, orden y cursor; los
componentes no vuelven a ordenar las filas recibidas.

Las rutas/métodos se generan a partir de `/docs-json` de la API local:

```sh
node packages/sdk/scripts/generate-crm.mjs /ruta/al/openapi.json
```

`apps/api/tests/crm-sdk.test.ts` compara las operaciones con OpenAPI y comprueba
que los parámetros de orden/cursor están documentados. Los E2E recorren la API
real, incluida la acción en lote.
