---
name: iaxti-context
description: Disciplina de contexto y ahorro de tokens al trabajar en IAxTi. Usar al iniciar una sesión, retomar trabajo, cerrar una sesión larga, o cuando el contexto se está llenando de código irrelevante.
---

# Disciplina de contexto (SPEC §32)

El repo es grande a propósito (spec de 1500 líneas, 84+ issues). Leerlo entero
cada sesión quema tokens y diluye la atención. Así se trabaja barato y
enfocado:

## Al empezar una sesión

1. Lee el **handoff** más reciente (comentario en el issue en curso o
   `docs/handoffs/`), NO el historial de la conversación anterior.
2. Lee SOLO: el Issue que vas a trabajar, la sección del SPEC de su módulo
   (la Parte B tiene una sección por módulo — usa el índice, no leas la spec
   completa), y el ADR del área si existe.
3. `/wayfinder` solo al iniciar una FASE, no cada sesión.

## Durante

- Un Issue por vez; el diff chico. Si descubres trabajo nuevo, crea un Issue
  (`gh issue create`) en vez de agrandarte el actual.
- `/zoom-out` únicamente antes de cambios que crucen módulos.
- No releas archivos que ya tienes en contexto; no pegues archivos enteros en
  discusiones — referencia `ruta:línea`.
- Búsquedas con Grep/Glob dirigidas antes que leer directorios completos.
- Las reglas ya están destiladas en `.claude/rules/` — consulta esas (cortas)
  en vez de re-derivarlas del SPEC.

## Al cerrar una sesión larga

`/handoff`: qué se hizo (PRs/issues), qué quedó a medias con su próximo paso
concreto, decisiones tomadas y dónde quedaron (ADR/comentario), y qué NO hay
que releer. Pégalo como comentario en el Issue en curso.

## Ahorro de tokens en el producto (no confundir con lo anterior)

El costo de IA del producto se controla en el código: contexto pequeño en
`conversations.get_context`, modelo por tarea (Flash/económico para volumen,
Pro solo configurador), cache de conocimiento por tenant, cuota visible
(SPEC §40 y ADR-0011). Cambios ahí pasan por el dataset de evaluación (#53).
