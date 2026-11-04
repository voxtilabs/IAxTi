# 0029 · El agente autónomo puede tomar una hora de la agenda

Estado: propuesto. Desvía ADR-0017 **solo** en `calendar.book`, y solo bajo
las condiciones de abajo. El resto de ADR-0017 sigue vigente, incluidas las
seis herramientas que quedan cerradas.

## Qué cambia

ADR-0017 dejó `calendar.book` fuera de las herramientas que la IA ejecuta.
A partir de acá la ejecuta, con la hora **validada contra la disponibilidad
real dentro del mismo cerrojo** que ya usa `agendar`.

## Qué estaba pasando

El SPEC promete esto en su tabla de dolores (`docs/SPEC.md:128`):

> | Agendar es un ping-pong | "¿Te acomoda el jueves?" cinco veces | La IA
> ofrece horarios reales de Calendar **y reserva** |

El producto hace la primera mitad. Ofrecer un horario es un `SELECT`
(`calendar/application/agenda.ts:195`): no escribe ninguna fila. Así que el
bot ofrece tres horas reales, el cliente elige una, **y el hueco sigue
libre** — se le vuelve a ofrecer al siguiente que pregunte.

Lo que el objetivo «Agendar» le dice al modelo (`agents/domain/objetivo.ts:86`):

> «Tú no tomas la hora: la ofreces… pasa la conversación para que alguien lo
> confirme y lo tome.»

Y su evento de éxito, dos líneas más abajo, es `appointment.created` — que
solo emite la ruta del panel. **El objetivo se mide con un evento que su
propio prompt le prohíbe causar.** No es que falle a veces: no puede acertar
nunca.

Y el traspaso no llega a nadie. La propuesta se guarda en `suggestions.accion`
y se publica `agent.suggested` (`autonomous.ts:496`), un evento **sin un solo
consumidor** en todo el repo; la fila vence a los quince minutos
(`agents/migrations/0003_suggestions.sql:18`). Ningún motivo de derivación
cubre «eligió una hora» (`escalation.ts:7`), y el barrido de conversaciones
desatendidas salta justamente las que atiende la IA (`conversations/sla.ts:44`).

Es el mismo hueco que #1243 cerró en el CRM, una pantalla más allá: el agente
PROPONE y en autónomo no hay nadie que apruebe.

## Por qué ahora sí, y qué cambió respecto de ADR-0017

ADR-0017 decidió con dos preguntas: **¿lo ve el cliente?** y **¿se puede
deshacer?** Las dos siguen siendo las correctas. Lo que cambió es la
respuesta.

- **¿Lo ve el cliente?** Esa pregunta protegía de un mundo donde la IA
  sugería y una persona enviaba. El modo autónomo (#49) ya cruzó esa línea:
  el bot entrega el mensaje él mismo (`copilot.ts:356`). En ese modo, la
  pregunta ya no discrimina — todo lo que hace el bot lo ve el cliente.
- **¿Se puede deshacer?** Una cita se cancela: `cambiarEstadoCita`
  (`agenda.ts:453`) la pasa a `cancelled` y retira el evento de Google. Deja
  rastro, libera el hueco y el cliente recibe el aviso. Es exactamente el
  criterio que dejó dentro a `crm.create_deal`.

Y se agrega una garantía que ADR-0017 no tenía cómo exigir:

- **La hora no la elige el modelo.** El argumento que mande se valida contra
  `huecosDelDia` del mismo día y dueño, **dentro del advisory lock** que
  `agendar` ya toma (`agenda.ts:338`). Si no es un hueco que el sistema
  ofrecería ahora mismo, se rechaza. Un domingo a las 3 AM no entra aunque el
  modelo lo pida con total seguridad.

Eso convierte `calendar.book` en algo distinto de las otras seis: no es «la
IA decide», es «la IA ejecuta una de las opciones que el sistema calculó».

## Lo que NO cambia

- Las otras seis siguen cerradas: `conversations.send_reply`,
  `conversations.set_state`, `crm.update_deal`, `payments.create_link`, y
  `calendar.reschedule` / `calendar.cancel`. Las dos últimas tienen su propio
  camino y su propio riesgo —mover la hora de alguien que no lo pidió— y van
  aparte, con su medición.
- El permiso manda igual: `calendar.book` se verifica contra la identidad a
  cuyo nombre actúa el agente (`limits.actua_como_user_id`, #1236). Sin ese
  permiso no agenda; el rol base USER no lo trae.
- Una escritura por generación (ADR-0017). Dos llamadas en la misma respuesta
  no crean dos citas.
- Se audita en la misma transacción, con `actor_kind = 'agent'` y la persona
  a cuyo nombre actuó.

## Lo que esto puede romper, dicho antes de que pase

Una cita equivocada es más cara que una oportunidad equivocada: el cliente se
presenta a una hora, o no se presenta a la que sí tenía. Tres cosas acotan el
daño y ninguna lo elimina:

1. La hora sale del sistema, no del modelo. El error posible es «agendó a
   quien solo preguntaba», no «agendó a una hora que no existe».
2. El recordatorio de 24 h (#1249) hace que una cita equivocada se descubra el
   día antes y no en la puerta.
3. Se cancela, y cancelar libera el hueco y avisa.

Lo que queda sin cubrir: un cliente que pregunta «¿qué horas tienen?» por
curiosidad y termina con una hora tomada. Eso se mide después de prenderlo,
mirando cuántas citas creadas por el agente terminan canceladas. Si esa
proporción es alta, esta ADR se revisa — y ese número no existe hoy, así que
el primer negocio que lo use es el que lo va a decir.

## Alternativas descartadas

- **Dejar que la propuesta espere a una persona.** Es lo de hoy y no
  funciona: nadie la recibe y vence en quince minutos. Arreglarlo implicaría
  construir el camino de avisos que `agent.suggested` nunca tuvo, para que una
  persona apruebe en vivo algo que el cliente está esperando en el chat.
  Cuesta más y entrega peor.
- **Un modo intermedio: tomar la hora y marcarla «por confirmar».** Es
  `proposed`, que ya existe. Pero una hora `proposed` no entra al barrido de
  recordatorios (#1249) y vuelve a dejar al cliente sin nada. Sería el mismo
  agujero con otro nombre.
