# platform → whatsapp · #901

Decisión: **`optional`**.

La salud sigue leyendo calidad y pausa de números persistidos con whatsapp apagado. El panel no necesita ejecutar el adaptador; mantenerlo activo permite ver qué número sigue en rojo durante una detención. Optional conserva ese diagnóstico. Un error leyendo whatsapp_numbers puede convertirse hoy en «Ningún número en rojo» por el catch: es una limitación preexistente, no una demostración de salud ni un arreglo de este PR.

## Evidencia de código

- `packages/modules/platform/application/salud.ts:486` — lee números en riesgo persistidos.
- `packages/modules/platform/application/salud.ts:495` — fallback de error a filas vacías.
- `packages/modules/platform/application/salud.ts:501` — cuenta números afectados y después calcula el estado.

## Verificación

`packages/modules/platform/tests/dependencia-whatsapp.test.ts` carga los
manifiestos reales, conserva solo el consumidor, sus requeridos transitivos y
el núcleo, y ejerce la lectura o la protección que justifica la dependencia.
Compara el orden de registry con `topologicalOrder` y repite migraciones reales
para comprobar idempotencia. Se ejecuta con PostgreSQL real en una base aislada.

```sh
pnpm --filter @iaxti/module-platform test tests/dependencia-whatsapp.test.ts
pnpm --filter @iaxti/core test tests/registry.test.ts tests/consultas-entre-modulos.test.ts
node scripts/consultas-entre-modulos.mjs --escribir
node scripts/consultas-entre-modulos.mjs
```

La regeneración baja **22 → 21** desde la base de esta rama y elimina únicamente
`platform→whatsapp`. Cada uno de los nueve pares de #901 tiene su propio PR;
esta rama no completa por sí sola la issue.

Se verifica apagado lógico con esquema conservado, no desinstalación física ni proveedor externo. Las consultas usan PostgreSQL real con el rol de fixture; esta prueba no certifica RLS de producción.
