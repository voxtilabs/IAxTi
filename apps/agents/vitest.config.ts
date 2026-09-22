import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Heredado de workers al mover el copiloto acá (#443): estos tests
  // escriben en el outbox global y correr varios archivos a la vez haría
  // que uno consuma los fixtures de otro.
  test: { fileParallelism: false },
});
