import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
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
);
