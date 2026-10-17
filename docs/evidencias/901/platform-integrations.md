# platform → integrations · #901

Decisión: **`optional`**.

La salud del SuperAdmin puede consultar entregas fallidas ya persistidas con integrations apagado. Es precisamente entonces cuando hace falta ver fallos; no invoca el reparto ni requiere nuevos consumidores. Optional conserva esa observación. El catch que transforma error SQL en lista vacía y «Todas las entregas salieron» es un defecto preexistente, no evidencia de degradación sana ni algo corregido por declarar la dependencia.

## Evidencia de código

- `packages/modules/platform/application/salud.ts:454` — consulta entregas fallidas.
- `packages/modules/platform/application/salud.ts:465` — fallback de error a lista vacía.
- `packages/modules/platform/application/salud.ts:480` — construye estado a partir del total.

## Verificación

`packages/modules/platform/tests/dependencia-integrations.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-integrations.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→integrations`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
