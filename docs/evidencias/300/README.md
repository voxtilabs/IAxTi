# Avisos, paleta y teclado · #300

`Avisos` monta Sonner una vez en cada aplicación. `AvisoResultado` adapta las
pantallas que guardan su resultado en estado React, con tonos Pulso y cierre
accesible. Los errores que sustituyen una pantalla conservan una explicación;
las advertencias de validación y las condiciones de negocio siguen junto a su
control. Los avisos de éxito/error de las operaciones usan el mismo componente.

La paleta usa cmdk y la navegación recibida por el shell. Ctrl+K / ⌘K permite
ir a una pantalla, buscar contactos y encontrar conversaciones mediante la API
existente, con los permisos de la sesión y el negocio seleccionado. La búsqueda
espera dos caracteres, descarta respuestas anteriores y cancela al cerrar.

En bandeja, j/k recorre conversaciones cargadas, e resuelve la abierta y ? abre
la ayuda visible. Una letra no ejecuta acciones dentro de campos editables,
durante composición de texto ni mientras otro diálogo/menú esté abierto.
Resolver usa el endpoint existente y bloquea la repetición mientras responde.

Los diálogos, menús y mensajes entran en 150 ms; los diálogos/menús salen en
150 ms. Sonner comparte esa duración. `prefers-reduced-motion: reduce` elimina
el movimiento; los nuevos controles conservan el foco Pulso de 2 px.

## Reproducción

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm depcruise
pnpm --filter @iaxti/ui test
pnpm --filter @iaxti/web test
pnpm --filter @iaxti/web e2e
```

El E2E requiere PostgreSQL y Redis de desarrollo. Siembra dos conversaciones
en un negocio sintético separado y verifica búsqueda/navegación, resolución
real por API, escritura sin disparar atajos, restauración del foco, un error
HTTP mostrado por Sonner y duración CSS con/sin movimiento reducido. También
corren las regresiones de bandeja y densidad. No envía mensajes a proveedores.

`paleta-dia-360.png` y `paleta-noche-360.png` muestran la paleta a 360 px. Se
comprueban foco de 2 px, ausencia de sombras y de desborde horizontal.
