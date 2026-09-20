# Tablas de CRM · #299

Contactos y oportunidades usan Table/DataTable de packages/ui, siguiendo el
[patrón de shadcn](https://v3.shadcn.com/docs/components/data-table) y
[ordenamiento manual de TanStack v8](https://tanstack.com/table/v8/docs/guide/sorting).
El servidor ordena y filtra. Las páginas usan cursor, con desempate por id,
nulos al final y precisión de microsegundos; cambiar búsqueda, orden o negocio
invalida la página y la selección anteriores.

La selección agrega una etiqueta a los contactos de esa página (en oportunidades,
a sus contactos). Conserva las etiquetas existentes, no borra registros, valida
todos los ids del tenant y registra auditoría/outbox en la misma transacción.
Reintentar no duplica asignaciones ni auditoría. El lote admite hasta 100 contactos.

Verificación:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm depcruise
pnpm turbo test --concurrency=1
pnpm --filter @iaxti/web e2e
```

Con PostgreSQL/Redis de desarrollo: pruebas de orden, empates, nulos, precisión,
cursores inválidos y cruzados; auditoría/rollback/idempotencia y permisos de API.
El E2E siembra un negocio separado con 30 contactos y oportunidades sintéticos;
comprueba orden, filtro, navegación por cursor, etiquetado real y ausencia de DELETE.
No se envían mensajes a proveedores.

Capturas día/noche a 360 px: `contactos-*.png` y `oportunidades-*.png`. Las columnas
secundarias se ocultan en móvil; el monto se mantiene en la celda principal. Se
verifican foco de 2 px y ausencia de desborde horizontal. El kanban se conserva.

La migración 0009 agrega índices a tablas existentes. No cambia filas, columnas,
permisos ni políticas RLS. Facturas, consumo y auditoría quedan para la migración
posterior: los criterios de esta issue piden contactos y oportunidades.
