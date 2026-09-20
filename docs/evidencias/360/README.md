# Contrato de rutas frontend/API · #360

La guarda en `packages/core/tests/rutas-frontend.test.ts` analiza el AST de
TypeScript: obtiene rutas desde `@Controller` y decoradores HTTP, y compara
las llamadas `apiFetch` y `fetch` hacia `/v1` en web y administración.

Resuelve literales, plantillas, concatenaciones, condiciones, variables,
funciones auxiliares locales, `useCallback` y uniones de literales de props.
Los ids dinámicos solo coinciden con parámetros del servidor. Una ruta opaca
falla con archivo y línea; no se acepta como comodín de cualquier endpoint.
Las queries se excluyen de la comparación. No ejecuta aplicaciones ni lee
credenciales; tampoco hace peticiones externas.

El test de regresión reproduce `/canales` y `/etiquetas` con su `.catch(() => [])`:
ambas fallan, aunque el frontend oculte su 404. Los casos incluyen rutas
inexistentes dentro de wrappers y callbacks importados. La comprobación es
estática de existencia de ruta: no sustituye autorización, validación de
payload ni pruebas HTTP/E2E. El SDK conserva sus propias pruebas OpenAPI.

CI ejecuta el paquete core completo en «Guardas de despliegue y rutas (sin
caché)», después de turbo, porque las entradas cruzan paquetes.

Validación local: 79 pruebas / 12 archivos de core con Postgres y Redis reales,
y comprobación TypeScript específica del analizador y sus casos. No cambia
código de ejecución, rutas públicas, permisos, base de datos ni proveedores.

```sh
DATABASE_URL=... REDIS_URL=... pnpm --filter @iaxti/core exec vitest run
```
