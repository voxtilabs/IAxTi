/**
 * Reglas de frontera del monolito modular (SPEC §26 regla 1, ADR-0007).
 * Una violación falla el PR. Verifica con: pnpm depcruise
 */
module.exports = {
  forbidden: [
    {
      name: 'modulos-solo-por-contract',
      comment:
        'Un módulo importa de otro SOLO por su contract.ts. Pide al módulo dueño que exponga lo que necesitas.',
      severity: 'error',
      from: { path: '^packages/modules/([^/]+)/' },
      to: {
        path: '^packages/modules/(?!$1/)[^/]+/',
        pathNot: '^packages/modules/[^/]+/contract\\.(ts|js|d\\.ts)$',
      },
    },
    {
      name: 'core-no-conoce-modulos',
      comment: 'packages/core no importa ningún módulo de negocio (SPEC §4).',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/modules/' },
    },
    {
      name: 'domain-sin-infraestructura',
      comment: 'domain/ no importa infraestructura ni api (SPEC §26).',
      severity: 'error',
      from: { path: '^packages/modules/[^/]+/domain/' },
      to: { path: '^packages/modules/[^/]+/(infrastructure|api)/' },
    },
    {
      name: 'sin-ciclos',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.next|\\.turbo|node_modules)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
