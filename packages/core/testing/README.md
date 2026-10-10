# `@iaxti/core/testing`

Este directorio no tiene código: es el **puente** que hace que
`import { fuenteLimpia } from '@iaxti/core/testing'` funcione (#569).

El código vive en `packages/core/src/testing/fuente-limpia.ts` y se compila a
`packages/core/dist/testing/`. Acá solo hay un `package.json` que apunta ahí.

## Por qué hace falta el puente

`tsconfig.base.json` usa `moduleResolution: "node"` (Node 10), que **no lee el
campo `exports`** de un `package.json`. Así que la subruta declarada en
`packages/core/package.json` la entienden `apps/web` —que usa `bundler`— y Node
en tiempo de ejecución, pero no `tsc` en los paquetes que heredan la base:
`core`, `ui`, `api` y los módulos. Con resolución Node 10, `@iaxti/core/testing`
se busca como un DIRECTORIO, y este `package.json` es lo que lo resuelve.

La alternativa era cambiar `moduleResolution` en todo el monorepo, que es un
cambio grande y arriesgado para publicar una función de ocho líneas. Cuando ese
cambio se haga por sus propios motivos, este directorio se puede borrar.
