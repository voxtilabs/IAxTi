import { defineConfig } from 'vitest/config';

/**
 * Los dos archivos de prueba de este paquete son dueños del MISMO tenant
 * demo: los dos lo borran en su `beforeAll` y lo vuelven a sembrar. En
 * paralelo se pisan —uno siembra mientras el otro está borrando— y
 * aparece un fallo que no tiene nada que ver con lo que se está probando:
 * «Ya existe un atajo "precios"».
 *
 * Es la misma familia de problemas que los tests que se tocan el
 * `process.env` entre hilos: vitest corre los ARCHIVOS en paralelo, y acá
 * el estado compartido es una base de datos.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
