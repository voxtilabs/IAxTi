import { defineConfig } from 'vitest/config';

/**
 * Los cinco archivos de test de este paquete comparten UNA base de datos, y
 * uno de ellos le cambia el esquema: `rls.test.ts` crea `rls_demo` y la
 * borra al terminar, mientras `inventario.test.ts` recorre el catálogo
 * buscando tablas con `tenant_id` — que es justamente lo que `rls_demo` es.
 *
 * En una base que ya tenía las migraciones aplicadas esto pasaba de largo.
 * En una base VIRGEN —la de CI, todas las veces— el `DROP TABLE` del
 * teardown se cruza con las migraciones que los otros archivos están
 * aplicando y Postgres corta con "deadlock detected". Reproducido 3 de 3.
 *
 * Los tests no fallan: falla el teardown, que es peor, porque el resumen
 * dice "13 passed" y la tarea igual sale en rojo.
 *
 * Correrlos en fila cuesta menos de dos segundos y elimina la clase entera
 * de problema. Paralelizar tests que se pelean por el mismo esquema es
 * ganar velocidad que después se paga en rojos que nadie sabe leer.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
