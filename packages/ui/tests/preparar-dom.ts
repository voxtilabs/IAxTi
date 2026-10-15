/**
 * Lo que necesita una prueba que RENDERIZA, y nada para las que no (#564).
 *
 * Dos cosas que, sin ellas, fallan con síntomas que no se parecen a su causa:
 *
 * 1. **Los matchers de `jest-dom`** (`toHaveTextContent`, `toBeVisible`…). Sin
 *    registrarlos el error es «Invalid Chai property: toHaveTextContent», que
 *    suena a que el matcher está mal escrito y no a que falta importarlo.
 * 2. **La limpieza entre pruebas.** Testing Library desmonta sola solo cuando
 *    detecta los globales del runner, y acá no se usan: el árbol de una prueba
 *    queda en el documento de la siguiente y los `getByTestId` empiezan a
 *    devolver «Found multiple elements». El síntoma aparece en la SEGUNDA
 *    prueba, así que acusa a la inocente.
 *
 * Este archivo lo cargan TODAS las del paquete, incluidas las que solo leen
 * código fuente y corren sin DOM. De ahí la guarda: en un entorno sin
 * `document`, importar los matchers revienta.
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  const [{ cleanup }, matchers, { expect }] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/matchers'),
    import('vitest'),
  ]);
  expect.extend(matchers.default ?? matchers);
  afterEach(() => cleanup());
}
