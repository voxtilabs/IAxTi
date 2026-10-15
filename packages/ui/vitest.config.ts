import { defineConfig } from 'vitest/config';

/**
 * Dos clases de prueba en el mismo paquete (#564).
 *
 * `.test.ts` lee el código fuente y busca patrones: hex sueltos, clases que
 * Tailwind no emite, contraste de los tokens. `.test.tsx` MONTA el componente
 * y lo usa. Las dos conviven y la extensión dice cuál es cuál de un vistazo.
 *
 * El entorno va por archivo (`// @vitest-environment jsdom` en la primera
 * línea) y no acá: las de fuente no necesitan DOM, y montarlo para todas sería
 * pagar su arranque por nada. Medido en esta máquina, con un archivo vacío:
 * 4,0 s con jsdom contra 3,2 s sin él.
 */
export default defineConfig({
  /**
   * El runtime automático de JSX, y nada más. Sin esto el JSX cae al runtime
   * clásico y revienta con `ReferenceError: React is not defined`, que no se
   * parece en nada a su causa.
   *
   * Sin `@vitejs/plugin-react`: lo único que agrega de más es fast refresh,
   * que una prueba no usa, y su versión espera otro mayor de Vite que el que
   * resuelve Vitest acá.
   */
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/preparar-dom.ts'],
  },
});
