# #373 · Agenda bajo concurrencia

Dos personas podían reservar a la vez una misma hora: SELECT e INSERT no estaban
serializados. El test previo que decía «a la vez» hacía dos llamadas en serie.
También era posible que una transición pisara una cancelación concurrente.

## Reproducción

Se abren dos transacciones reales. La primera reserva o cancela, manteniendo el
commit pendiente. La segunda intenta reservar/actualizar. La prueba observa que
termine o espere a la primera mediante `pg_blocking_pids`, sin dormir un plazo
arbitrario. Después del commit, solo puede quedar la primera decisión válida.
Sobre main 454a185 fallaban las dos carreras y la aserción de auditoría.

## Cambio

- Lock transaccional por tenant/responsable antes de comprobar cruces. Los UUID
  se normalizan en PostgreSQL antes de formar la clave: mayúsculas u otros formatos
  equivalentes no abren agendas distintas. No requiere extensión ni migración.
- Las transiciones leen la cita con FOR UPDATE y revalidan el estado ya confirmado.
- Reserva y cambio de estado escriben auditoría, con actor/kind/requestId, en la
  transacción existente. La API conserva la identidad de una API key.
- Fechas inválidas se rechazan antes de consultar la agenda.

## Validación

Diez pruebas nuevas: carreras reales, variantes de UUID, horas contiguas,
responsables distintos, tenant independiente, fechas inválidas, RLS activo,
auditoría encadenada y rollback completo. Se conserva la regresión de disponibilidad
y recordatorios. Resultado: 33 pruebas de calendar, 72 de workers, 183 de API
y 27 de db correctas con PostgreSQL/Redis locales. También se verifican los
consumidores de agenda y los barridos con un rol que respeta RLS.

La comprobación de integridad descubrió #375; su corrección se integra antes de
este cambio. No se oculta la aserción ni se reescribe el historial para pasarla.

## Alcance

El lock protege las reservas que usan el contrato `agendar`; SQL escrito fuera de
ese contrato no participa. Se conserva la semántica existente: proposed, confirmed
y reminded ocupan agenda. Google free/busy/OAuth sigue en #57 y los recordatorios
reales en #59. No se crean eventos en Google ni se envían avisos a clientes.
