import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import iaxti from './tools/eslint-reglas/catch-sobre-cliente-ajeno.mjs';

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
      // Copias completas del repo que crea `isolation: worktree` de los
      // workflows (#611). `eslint .` se mete y lintea todo dos veces: 190
      // errores que no son de nadie, en el comando que de verdad cuenta. Ya
      // están en .gitignore; esto es su otra mitad.
      '**/.claude/worktrees/**',
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
   * El `.catch()` sobre el cliente ajeno (#966).
   *
   * Va como regla de lint y no como escáner de texto porque los dos greps que
   * se intentaron en #970 descuadraban con los literales SQL de varias líneas.
   * El AST sabe dónde termina una consulta; un `grep` no.
   *
   * Solo donde hay transacciones: el front no tiene PoolClient.
   */
  {
    files: ['apps/api/**/*.ts', 'apps/workers/**/*.ts', 'apps/agents/**/*.ts', 'packages/**/*.ts'],
    plugins: { iaxti },
    rules: { 'iaxti/catch-sobre-cliente-ajeno': 'error' },
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
