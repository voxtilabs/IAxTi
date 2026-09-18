# ADR 0017 · Qué puede escribir la IA, y qué no

**Estado:** aceptada · 2026-09-18 · complementa la
[ADR-0010](0010-assist-por-defecto-autonomo-opt-in.md)

## Contexto

Los módulos declaran 16 herramientas. Las de lectura ya se ejecutan (#240,
#269): el modelo puede pedir el contexto de la conversación, buscar en el
conocimiento, mirar un producto y ofrecer horarios — con la identidad de la
persona dueña de la conversación, el permiso verificado en cada llamada y el
rastro como acción de la IA.

Las nueve que escriben estaban declaradas y devolvían un error diciendo que
faltaba decidir hasta dónde actúa la IA sola. Esta ADR decide.

La ADR-0010 ya fijó el principio: **el copiloto sugiere y el humano envía**.
Lo que falta no es ese principio sino su borde: qué acciones puede completar
la IA sin que alguien confirme.

## El criterio

Dos preguntas, en este orden:

1. **¿Lo ve el cliente?** Si el resultado sale del negocio hacia afuera —un
   mensaje, una hora reservada, un cobro—, no lo hace la IA sola. Un error
   hacia adentro se corrige; uno que ya llegó al cliente, no.
2. **¿Se puede deshacer?** No "¿se puede borrar?" —acá no se borra nada—
   sino: ¿existe un estado que deje las cosas como si no hubiera pasado? Una
   actividad se marca hecha o se cancela. Una oportunidad se marca perdida.
   Una hora agendada le ocupó el calendario a alguien y le mandó una
   confirmación: eso ya pasó.

## Decisión

**Se habilitan dos**, las que quedan adentro y se deshacen:

| Herramienta | Por qué |
|---|---|
| `crm.create_activity` | Una nota o una tarea. No la ve el cliente; se cancela. |
| `crm.create_deal` | Una oportunidad en la primera etapa abierta. No la ve el cliente; se marca perdida. El copiloto **ya** proponía crearla (`suggest_deal`): esto le deja hacer lo que ya recomendaba. |

**Siguen cerradas las siete restantes**, cada una por su motivo:

| Herramienta | Por qué no |
|---|---|
| `conversations.send_reply` | Lo ve el cliente. Y ya existe el modo autónomo (ADR-0010) para eso, con sus reglas de escalamiento: una segunda puerta al mismo sitio, sin esas reglas, sería un agujero. |
| `conversations.set_state` | Cerrar una conversación esconde trabajo pendiente de un humano. |
| `crm.update_deal` | Pisa lo que una persona escribió. Crear no pisa nada. |
| `calendar.book` / `reschedule` / `cancel` | Le ocupa la hora a alguien y le manda una confirmación al cliente. Irreversible en la práctica. La IA **ofrece** horarios (`calendar.get_slots`) y una persona toma. |
| `payments.create_link` | Una IA generando cobros. Es la única de la lista donde equivocarse cuesta plata de verdad. |

**Dos guardas más sobre las habilitadas:**

- **Una escritura por generación.** El bucle tiene tope de cuatro pasos; sin
  esto, un modelo que se traba podría crear tres oportunidades del mismo
  cliente en una respuesta. La segunda llamada le devuelve el motivo al
  modelo, que sigue respondiendo.
- **Solo en etapa abierta.** `crm.create_deal` no elige etapa: nace en la
  primera abierta del pipeline. La IA no gana ni pierde negocios.

## Consecuencias

El tenant sigue decidiendo: `allowed_tools` del agente es por tenant, así que
habilitarlas es una elección del negocio, no un cambio que le llega puesto.

El permiso es el de la persona dueña de la conversación. Un vendedor cuyo rol
no puede crear oportunidades tampoco se las crea la IA a su nombre.

Todo queda en `audit_log` con `actor_kind = 'agent'` y la persona a cuyo
nombre actuó. Cuando alguien pregunte "¿quién creó esta oportunidad?", la
respuesta distingue entre la persona y la IA actuando por ella.

## Se revisa cuando

Cuando haya conversaciones reales suficientes para mirar cuántas de las
oportunidades que creó la IA terminaron marcadas como perdidas por error. Ese
número, y no una intuición, decide si se abre `crm.update_deal`.

`payments.create_link` no se abre sin un interruptor propio por tenant,
apagado por defecto, y eso es otra ADR.
