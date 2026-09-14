import { defineConfig, devices } from '@playwright/test';

// El criterio de salida de la Fase 2 se juega en celular (SPEC §31):
// el e2e corre SOLO en viewport móvil. Orquestación: e2e/run-e2e.mjs.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4011',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'celular',
      use: { ...devices['Pixel 7'] }, // chromium: un solo browser en CI
    },
  ],
});
