/**
 * Los tipos de los matchers de `jest-dom` (`toHaveValue`, `toBeEnabled`…).
 *
 * Van en un `.d.ts` aparte y no en el archivo de preparación porque son dos
 * cosas distintas: el de preparación los REGISTRA en tiempo de ejecución, y
 * solo cuando hay DOM; esto le dice a TypeScript que existen. Sin esto el
 * typecheck falla con «Property 'toHaveValue' does not exist», que suena a
 * matcher mal escrito y no a un import que falta.
 */
import '@testing-library/jest-dom/vitest';
