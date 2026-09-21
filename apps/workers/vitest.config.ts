import { defineConfig } from 'vitest/config';

export default defineConfig({
  // El dispatcher recorre el outbox global. Los tests de productores también
  // lo llenan: ejecutarlos a la vez consumiría fixtures de otra prueba.
  test: { fileParallelism: false },
});
