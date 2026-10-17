# analytics → conversations · #901

Decisión: **`optional`**.

El tablero puede seguir leyendo el histórico y agregando ventas/uso de IA aunque conversations esté apagado. No necesita que el productor de conversaciones siga activo para esas lecturas; el apagado conserva sus tablas (SPEC §26.5). Required impediría ese modo de consulta sin que el código lo necesite.

## Evidencia de código

- `packages/modules/analytics/application/dashboard.ts:117` — cuenta pendientes persistidos.
- `packages/modules/analytics/application/aggregate.ts:59` — deal.won agrega ventas sin invocar conversations.
- `packages/modules/analytics/application/aggregate.ts:84` — lee costo del mensaje persistido.
- `packages/modules/analytics/application/aggregate.ts:156` — toma muestras de conversaciones ya respondidas.

## Verificación

`packages/modules/analytics/tests/dependencia-conversations.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-analytics test tests/dependencia-conversations.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`analytics→conversations`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
