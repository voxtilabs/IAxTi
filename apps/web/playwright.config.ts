import { defineConfig, devices } from '@playwright/test';

// El criterio de salida de la Fase 2 se juega en celular (SPEC §31):
// el e2e corre SOLO en viewport móvil. Orquestación: e2e/run-e2e.mjs.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  /**
   * El plazo de cada `expect`, y por qué no son los 5 s de fábrica (#654).
   *
   * La suite corre con cuatro workers contra UN proceso de API y UN Postgres, en
   * la misma máquina. Con esa competencia, cinco segundos no miden el producto:
   * miden qué tan ocupada estaba la máquina en ese instante. Se notaba en la
   * forma del rojo — `bandeja.spec` caía en la aserción de «Resuelta» una vez y
   * en la de la lista de conversaciones la siguiente, y aislada pasaba 3/3.
   *
   * Un rojo intermitente es peor que no tener la prueba: esta es el criterio de
   * salida de la Fase 2 (SPEC §31) y se estaba reintentando sin mirar, que es lo
   * que hay que evitar el día que se rompa de verdad.
   *
   * Diez segundos, no más: el `timeout` de 60 s por prueba sigue siendo el techo
   * y una pantalla que tarde de verdad sigue dando rojo.
   */
  expect: { timeout: 10_000 },
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
