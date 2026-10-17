# billing → analytics · #901

Decisión: **`required`**.

La facturación necesita el agregador activo, no solo su tabla: metaSpentUsd cobra desde daily_metrics; no existe una fuente alternativa ni una señal de agregado detenido. El dispatcher omite los consumidores de analytics cuando está apagado. Dejar billing activo con analytics deshabilitado permite facturar con costo de Meta incompleto. Required bloquea ese apagado ordinario y la reactivación de billing sin analytics.

## Evidencia de código

- `packages/modules/billing/application/billing.ts:134` — metaSpentUsd suma el agregado sin alternativa.
- `packages/modules/billing/application/billing.ts:191` — costos del ciclo usa ese agregado.
- `packages/modules/billing/application/billing.ts:224` — la factura usa el mismo agregado.
- `packages/modules/analytics/application/aggregate.ts:77` — message.sent produce costo_meta_usd.
- `packages/core/src/dispatcher.ts:73` — salta consumidores cuyo módulo está apagado.

## Required sin import

`packages/core/src/dependencias-declaradas.ts` registra `billing→analytics` en
`REQUERIDAS_SIN_IMPORT`: la dependencia exige que siga activo el productor del
costo, aunque billing lea su agregado por SQL y no importe el contrato.
La guarda de dependencias exige que la entrada tenga motivo, siga declarada
como required y no se vuelva obsoleta si aparece un import. No se modifica la
guarda ni se cambia la dependencia a optional.

## Verificación

`packages/modules/billing/tests/dependencia-analytics.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-billing test tests/dependencia-analytics.test.ts
pnpm --filter @iaxti/core test
pnpm --filter @iaxti/core typecheck
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`billing→analytics`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción. El kill-switch de emergencia puede saltarse required en el registry actual; este cambio protege disable/enable ordinarios, no promete resolver esa política global.

La prueba de combinación existente `dependencia-analytics.test.ts` cubre la
composición mínima, el rechazo al apagar analytics con billing activo y el
rechazo al reactivar billing sin analytics. Se conserva sin duplicarla; la
suite completa de core incluye además `combinations.test.ts` y la guarda de
`REQUERIDAS_SIN_IMPORT` que faltó ejecutar en la primera verificación.
