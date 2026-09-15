# Resultados de los simulacros de DR

Se anota **lo que pasó**, no lo que se esperaba. Un simulacro sin tiempos
reales es una casilla marcada, no una prueba.

Formato: fecha · simulacro · ambiente · tiempo real · compromiso · desvío.

| Fecha | Simulacro | Ambiente | Tiempo real | Compromiso | Resultado |
|---|---|---|---|---|---|
| 2026-09-14 | Rollback a versión **no cacheada** | staging | **192 s** | < 120 s | ⚠️ desviación (issue abierto) |
| 2026-09-14 | Rollback a versión **cacheada** (vuelta) | staging | **24 s** | < 120 s | ✅ |
| _(pendiente)_ | Restore PITR de Postgres | staging | — | RTO < 1 h | — |
| _(pendiente)_ | Restore de Redis desde R2 | staging | — | < 15 min | — |
| _(pendiente)_ | VPS completo limpio | — | — | RTO < 1 h | — |

## Simulacro 2 · rollback en staging (2026-09-14) — cumplido, con desviación

Segundo intento, con el SHA completo. **Funcionó y es verificable desde
afuera**: se volvió a la imagen anterior al arreglo de HSTS y la cabecera
`Strict-Transport-Security` **desapareció** de las respuestas; al volver
adelante, reapareció. Eso es lo que prueba que el rollback cambió el código
que corre — no que el panel diga "done".

| | ida (a imagen vieja) | vuelta (al main actual) |
|---|---|---|
| tiempo | **192 s** | **24 s** |
| imagen en el host | no estaba: hubo que bajarla | ya estaba, recién usada |

**La diferencia es el `docker pull`.** El compromiso de menos de 2 minutos
se cumple cuando se vuelve a la versión inmediatamente anterior —que es el
caso real de un incidente, porque se viene de ella y sigue en caché— y
**no** se cumple al saltar a una versión más vieja, que hay que bajar de
GHCR. Eso es una desviación real y quedó como issue, no como nota al pie.

Otro dato del simulacro: **el rollback no es sin corte**. Durante el cambio
de contenedores hubo unos segundos de 404. Para un incidente en el que la
app ya está caída da lo mismo; para un rollback preventivo, no.

## Simulacro 1 · rollback en staging (2026-09-14) — FALLÓ, y sirvió

Primer intento del simulacro de rollback. **Falló, y por eso valió la pena.**

Se pasó el SHA **incompleto** (los tags de imagen son el SHA de 40
caracteres). Dokploy no encontró la imagen y el redeploy quedó en `error`.
Staging **no se cayó** —Dokploy mantuvo los contenedores viejos corriendo—
pero el proyecto quedó con `IMAGE` apuntando a algo inexistente hasta el
siguiente deploy.

Lo que enseñó: **el rollback tenía que verificar que la imagen existe antes
de tocar la configuración**. Se corre bajo presión, con el tag copiado a
mano, y con el incidente original todavía abierto. Agregado.

Tiempo: no aplica (abortó). Se repite con el SHA completo.

## Hallazgos del primer repaso (2026-09-14)

Antes de correr ningún simulacro, leer el procedimiento ya encontró un
problema serio:

- **El workflow de rollback borraba el entorno del proyecto.** Mandaba a
  Dokploy `env: "IMAGE=..."` como bloque completo, en vez de leer el env
  actual y reemplazar solo esa línea — que es lo que sí hace el deploy. Un
  rollback habría dejado la app sin `DATABASE_URL` ni el resto de la
  configuración, justo en el momento en que se la necesita de vuelta. Y el
  `|| true` del comando hacía que el fallo pasara en silencio. Corregido en
  #80, junto con la espera, la verificación de salud y el cronómetro.

Los otros tres simulacros necesitan credenciales que no están en el
repositorio (panel de Supabase, bucket de R2, un servidor limpio): quedan
como tarea con dueño humano, no como casilla marcada.
