# ADR 0019 · Una rama `staging`, y main como lo ya probado

**Estado:** aceptada · 2026-09-20 · desvía de la regla trunk-based de
`.claude/rules/git.md` · pedida por Lino

## Contexto

Hasta ahora: PR → squash a `main` → build → despliegue automático a staging
→ tag `vX.Y.Z` → producción. Trunk-based, sin develop ni release/*.

El problema, dicho por Lino: *"todo está quedando en main"*. Y es exacto:
`main` era a la vez el historial revisado y lo que corre en staging. No
había dónde dejar algo para probarlo sin que quedara en el historial para
siempre. Con dos personas y una IA cada una entrando PRs seguidos, eso se
siente rápido.

## Decisión

`staging` es la rama de integración y de la que sale lo que corre en el
ambiente de staging. `main` pasa a ser **lo ya probado ahí**.

```
PR  ──▶  staging  ──build──▶  despliegue a staging
              │
              └─ promoción (ff-only) ──▶  main  ──tag vX.Y.Z──▶  producción
```

- Los PR se abren contra `staging`.
- Promover es `git merge --ff-only staging` sobre main. **Tiene que
  conservar los SHA**, y no es una preferencia de estilo: `release.yml`
  promueve la imagen del commit EXACTO que se taguea
  (`ghcr.io/voxtilabs/iaxti:${GITHUB_SHA}`) y falla a propósito si no
  existe, en vez de caer en `:staging`, que es un tag móvil. Un merge commit
  nuevo no tiene imagen.
- Por si alguien promueve con un merge de verdad, `build` sigue corriendo
  también en `main`: la imagen existe igual y la release no se rompe el día
  que importa.
- `deploy-staging` solo corre para builds cuya rama sea `staging`. Sin esa
  condición, cada promoción a main redesplegaría staging con lo mismo que ya
  tiene y pisaría lo que estuviera probándose.

## El costo, dicho claro

Esto es peor que trunk-based en un aspecto concreto y conviene tenerlo
escrito: **dos ramas largas divergen**. Si `main` recibe un hotfix directo,
hay que bajarlo a `staging` o el siguiente ff-only falla y la promoción se
vuelve un merge — justo lo que rompe la promoción de imagen.

La regla para que eso no pase: **nada entra a `main` que no haya pasado por
`staging`**, hotfix incluido. Un hotfix es un PR contra `staging` que se
promueve en seguida.

Lo que NO cambia: el PR con CI verde y squash sigue siendo lo que protege
la rama. Esta ADR mueve el destino, no afloja el filtro.

## Alternativas descartadas

**Seguir en trunk-based.** Es lo que yo habría recomendado para un equipo de
dos: el PR con CI ya impide que entre lo no listo, y una rama larga agrega
deuda de merge sin agregar seguridad. Pero no resuelve lo que molesta, que
no es seguridad sino que main acumule todo.

**Desplegar staging desde cualquier rama a demanda.** `workflow_dispatch` ya
lo permite y se mantiene. No sirve como modelo porque dos fuentes hacia el
mismo ambiente se pisan: la concurrencia cancela la anterior y gana la
última, así que quedaría corriendo lo que nadie pidió.

## Reversión

Tres líneas: `branches: [main]` en `build.yml`, quitar la condición de
`head_branch` en `deploy-staging.yml`, y volver la rama por defecto a `main`.
La rama `staging` se puede borrar después.
