# platform → channels · #901

Decisión: **`optional`**.

La ficha del tenant y salud consultan las cuentas ya persistidas. El panel necesita seguir mostrando cuentas degradadas mientras se detiene channels; no invoca el envío ni la conexión del módulo. Optional permite diagnosticar ese estado con platform activo. La ausencia física de channel_accounts o un error SQL NO son degradación sana: healthSnapshot los convierte hoy en un cero verde; ese defecto queda documentado, no se usa para justificar optional.

## Evidencia de código

- `packages/modules/platform/application/tenants-admin.ts:54` — tenantDetail lee estado persistido y propaga error SQL.
- `packages/modules/platform/application/salud.ts:291` — healthSnapshot lee cuentas.
- `packages/modules/platform/application/salud.ts:298` — catch devuelve filas vacías; no prueba fuente sana.
- `packages/modules/channels/module.yaml:1` — apagado de plataforma y núcleo formal son conceptos distintos.

## Verificación

`packages/modules/platform/tests/dependencia-channels.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-channels.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→channels`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
