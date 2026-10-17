# platform → audit · #901

Decisión: **`required`**.

La seguridad de platform requiere el libro del núcleo: las consultas de permisos denegados no tienen fallback y las acciones administrativas escriben auditoría mediante su contrato. No hay modo válido de operación de platform sin audit. Required documenta esa obligación y coloca audit antes de platform; audit ya es núcleo y no era apagable.

## Evidencia de código

- `packages/modules/platform/application/salud.ts:383` — denegaciones leídas del audit_log sin catch.
- `packages/modules/platform/application/salud.ts:395` — total leído del mismo libro.
- `packages/modules/platform/application/tenants-admin.ts:26` — acciones administrativas usan writeAudit.
- `packages/core/src/registry.ts:4` — audit pertenece al núcleo.

## Verificación

`packages/modules/platform/tests/dependencia-audit.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-audit.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→audit`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
