# Resultados de los simulacros de DR

Se anota **lo que pasó**, no lo que se esperaba. Un simulacro sin tiempos
reales es una casilla marcada, no una prueba.

Formato: fecha · simulacro · ambiente · tiempo real · compromiso · desvío.

| Fecha | Simulacro | Ambiente | Tiempo real | Compromiso | Resultado |
|---|---|---|---|---|---|
| _(pendiente)_ | Rollback de release | staging | — | < 2 min | — |
| _(pendiente)_ | Restore PITR de Postgres | staging | — | RTO < 1 h | — |
| _(pendiente)_ | Restore de Redis desde R2 | staging | — | < 15 min | — |
| _(pendiente)_ | VPS completo limpio | — | — | RTO < 1 h | — |

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
