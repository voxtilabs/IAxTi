import { defineConfig } from 'vitest/config';

// Solo pruebas unitarias del lado servidor y del snippet público. El e2e de
// la bandeja va aparte, con Playwright (`pnpm e2e`): son cosas distintas y
// mezclarlas hace que ninguna se corra bien.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
