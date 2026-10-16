# platform → conversations · #901

Decisión: **`optional`**.

La vista previa de retención necesita contar conversaciones históricas aun cuando el módulo de operación esté apagado. Lee estado y última fecha; no ejecuta consumidores, no envía mensajes y no exige conversaciones activas. Optional conserva la administración del histórico. No se considera soportado borrar físicamente el esquema: esa consulta fallaría y el apagado no borra datos.

## Evidencia de código

- `packages/modules/platform/application/planes.ts:235` — tenantRetentionPreview lee política y calcula corte.
- `packages/modules/platform/application/planes.ts:256` — cuenta conversaciones históricas cerradas.
- `docs/SPEC.md:983` — apagar no toca los datos.

## Verificación

`packages/modules/platform/tests/dependencia-conversations.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-conversations.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→conversations`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
