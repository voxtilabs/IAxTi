# ADR-0030 · El cliente puede mover su hora hablando con el agente

- **Estado:** aceptada
- **Fecha:** 2026-11-07
- **Revisa:** [ADR-0017](0017-que-puede-escribir-la-ia.md) (parcialmente),
  [ADR-0029](0029-el-agente-autonomo-toma-la-hora.md) (la extiende)
- **Issues:** #1283, apoyada en #1251

## Contexto

El objetivo `agendar` tenía tres herramientas: `calendar.get_slots`,
`calendar.book` y `conversations.get_context`. Toma la hora y ahí termina.

«Necesito cambiar mi hora del jueves» es, después de pedirla, lo que más se
pide. El agente no tenía con qué, así que escalaba a una persona. En una pyme
de una o dos personas eso significa que el cliente espera hasta que alguien
mire el teléfono — y la razón por la que escribió es justamente que el jueves
no va a poder.

La ADR-0017 cerró `calendar.reschedule` junto con `calendar.cancel`, y el
motivo que escribió es bueno:

> mover o cancelar la hora de alguien que no lo pidió es otro riesgo y
> necesita su propia medición.

## La decisión

Se abre `calendar.reschedule` al agente. `calendar.cancel` **sigue cerrada**.

## Por qué ahora, y qué cambió

Dos cosas, las dos del mismo día:

- **ADR-0029** abrió `calendar.book` con la garantía de que el horario se
  valida contra la disponibilidad real dentro del cerrojo.
- **#1251** extendió esa garantía a mover. Antes de ese PR, `reagendarCita`
  comprobaba que no chocara con otra cita y nada más: la garantía del ADR-0029
  se esquivaba moviendo —tomar un hueco legítimo y después correrlo a las tres
  de la mañana de un domingo—. Ahora valida el hueco y la duración dentro del
  mismo cerrojo.

O sea que el requisito técnico ya está. Lo que quedaba era el riesgo que la
ADR-0017 nombró: mover la hora de **alguien que no lo pidió**.

## Cómo se contesta ese riesgo

No con una regla del prompt. Un prompt que dice «mueve solo la cita de quien
te escribe» se incumple el día que el modelo alucina un UUID, y eso no es una
hipótesis sobre este repo: es la razón por la que `calendar.book` tampoco
recibe el día ni el dueño.

Se contesta con la **firma de la herramienta**: `calendar.reschedule` recibe
un horario y nada más. **No recibe un id de cita.** La cita la elige el
sistema con `citasFuturasDelContacto`, a partir de quién está escribiendo:

- **ninguna cita futura** → no se mueve nada, y el agente lo dice: «no tienes
  una hora tomada, ¿quieres tomar una?»;
- **una** → se mueve;
- **más de una** → no adivina. Escala a una persona.

Si la herramienta no acepta un id, no hay id que alucinar. El riesgo no queda
improbable: queda imposible de expresar.

## Por qué `calendar.cancel` no entra

El daño no es simétrico. Mover deja a la persona con una hora distinta;
cancelar la deja sin ninguna. Y el error típico del modelo tampoco es
simétrico: confundir «no voy a poder el jueves» con «cancela» es un error que
le cuesta la hora al cliente y el espacio al negocio, mientras que mover de
más se arregla moviendo de vuelta.

Cuando haya conversaciones reales con esta herramienta andando, la pregunta de
cancelar se vuelve a abrir con datos y no con criterio.

## Lo que esto NO resuelve, dicho para que nadie lo suponga

- **Dos citas futuras escalan.** Es deliberado y es el caso del cliente que
  tiene una hora para él y otra para su hijo. Resolverlo bien pide que el
  agente pregunte cuál, y eso es una conversación de varios turnos sobre datos
  que hoy no se le muestran.
- **El cliente no puede cancelar.** Sigue siendo trabajo de una persona.
- **No avisa al dueño.** La cita movida queda en el audit con
  `actorKind: 'agent'` y `motivo: 'Lo pidió el cliente por WhatsApp'`, pero
  nadie recibe una notificación. Si el dueño ya tenía ese bloque en la cabeza,
  se entera mirando la agenda.
