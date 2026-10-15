import { defineConfig } from 'vitest/config';

// Solo pruebas unitarias del lado servidor y del snippet público. El e2e de
// la bandeja va aparte, con Playwright (`pnpm e2e`): son cosas distintas y
// mezclarlas hace que ninguna se corra bien.
export default defineConfig({
  /**
   * El runtime automático de JSX, y nada más.
   *
   * Sin esto el JSX cae al runtime clásico y revienta con
   * `ReferenceError: React is not defined` — un síntoma que no se parece en
   * nada a su causa. El `tsconfig` de este paquete dice `"jsx": "preserve"`
   * porque el que compila es Next, y Vitest no lo hereda.
   *
   * Sin `@vitejs/plugin-react`: lo único que agrega de más es fast refresh,
   * que una prueba no usa, y su versión espera otro mayor de Vite que el que
   * resuelve Vitest acá — el typecheck lo marca aunque las pruebas corran.
   * Menos dependencia y menos desalineación.
   */
  esbuild: { jsx: 'automatic' },
  test: {
    /**
     * `.tsx` también, para las pruebas que RENDERIZAN (#564).
     *
     * Las de `.test.ts` leen el código fuente y buscan patrones; las de
     * `.test.tsx` montan el componente y lo usan. Las dos conviven, y la
     * extensión dice cuál es cuál de un vistazo.
     *
     * El entorno va por archivo (`// @vitest-environment jsdom` en la primera
     * línea) y no acá: las 42 de fuente no necesitan DOM y montarlo para todas
     * sería pagar su arranque por nada. Medido: 4,0 s con jsdom contra 3,2 s
     * sin él, por archivo.
     */
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/preparar-dom.ts'],
  },
});
