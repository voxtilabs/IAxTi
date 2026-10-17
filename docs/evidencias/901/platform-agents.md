# platform → agents · #901

Decisión: **`optional`**.

El Centro de IA y el panel del Agente General leen ejecuciones, configuración y evaluaciones persistidas. Siguen siendo útiles cuando se apaga el productor agents para diagnosticarlo; no invocan su runtime ni necesitan consumir nuevas ejecuciones. Optional conserva ese acceso histórico sin obligar a apagar el panel para detener la IA.

## Evidencia de código

- `packages/modules/platform/application/centro-ia.ts:71` — aiMetrics agrega ejecuciones persistidas.
- `packages/modules/platform/application/centro-ia.ts:195` — aiExecutions lee el historial.
- `packages/modules/platform/application/centro-ia.ts:231` — promptsActivos une agents con última evaluación.
- `packages/modules/platform/application/agente-general-panel.ts:149` — corridasDelAgenteGeneral lee el historial.

## Verificación

`packages/modules/platform/tests/dependencia-agents.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-agents.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→agents`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
