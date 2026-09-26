import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'infra/**', // scripts k6 (#79): globals propios de k6 (__ENV/__VU)
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      '**/*.cjs',
      '**/*.mjs', // scripts de configuración y orquestación (corren en node)
      '**/public/**', // assets estáticos del navegador (snippet del webchat)
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // La regla de oro de autorización (ADR-0008) también se caza por lint:
      // los guards se verifican en /security-review; aquí lo básico estricto.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  /**
   * Las reglas de los hooks (#561).
   *
   * Faltaban, y el precio fue concreto: puse un `useArrastre` después del
   * `return` de «elige una conversación» en la bandeja, así que al elegir la
   * primera React pasaba de N a N+1 hooks y reventaba el panel entero —en
   * blanco, sin mensajes ni campo de texto. Lo cazó la suite E2E, que tarda dos
   * minutos; esta regla lo caza en el editor y es de una línea.
   *
   * `rules-of-hooks` es ERROR porque no es estilo: el componente se rompe.
   * `exhaustive-deps` queda como aviso a propósito — hay dependencias omitidas
   * a conciencia en el código de hoy, y convertirlas en error de golpe obliga a
   * tocar pantallas que funcionan dentro de un PR que no es de eso.
   */
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
