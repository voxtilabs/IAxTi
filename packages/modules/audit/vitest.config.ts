import { defineConfig } from 'vitest/config';

/**
 * Los archivos de este paquete corren de a UNO.
 *
 * `audit.test.ts` y `export.test.ts` apagan y prenden el mismo trigger —
 * `audit_log_no_update_delete`— para poder simular una fila manipulada y
 * para limpiar. Ese trigger es de la TABLA, no de la conexión: apagarlo lo
 * apaga para todos.
 *
 * Con los archivos en paralelo se pisan: uno lo apaga justo cuando el otro
 * está comprobando que un DELETE se rechaza, y el test falla diciendo que
 * la tabla append-only acepta borrados. Lo que falla no es el producto, es
 * el otro archivo.
 *
 * Se veía poco porque la caché de turbo servía estos tests sin correrlos.
 * Desde que los manifiestos invalidan la caché (#333), corren de verdad y
 * la carrera aparece.
 *
 * No se arregla dejando de apagar el trigger: un test TIENE que manipular
 * una fila para probar que la cadena de hashes lo detecta. Lo que no puede
 * es hacerlo mientras otro mira.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
