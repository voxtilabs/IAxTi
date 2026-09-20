# #372 · Revalidación de salientes

IAxTi atiende y hace seguimiento por WhatsApp. Un mensaje que era válido al
encolarse puede dejar de serlo mientras espera silencio, rate limit o reintento.

## Reproducción y cambio

Sobre main `454a185`, la primera regresión falló en 12 de 13 casos: opt-out,
ventana vencida, desconexión, plantilla pausada y reentrega de mensajes terminales.
La prueba de consumidores simultáneos invocaba al proveedor dos veces antes de
rechazar el segundo avance `sent → sent`.

El worker vuelve a consultar el contexto persistido antes de enviar. El contrato
`conversations.getOutboundContext` bloquea solo la fila del mensaje hasta el
commit y expone estado de entrega, contacto y último entrante. Los duplicados ya
confirmados terminan sin una nueva petición. Consentimiento usa el contrato CRM;
cuenta, templates aprobadas y ventana usan los contratos existentes de sus dueños.
No hay consultas del worker a tablas de otro módulo.

La cuenta degraded conserva respuestas manuales: calidad roja pausa lo iniciado
por el negocio. Una plantilla debe conservar id, nombre, idioma, categoría y texto
renderizado; el job no puede sustituir su metadata. Los rechazos persisten failed
y message.failed en la misma transacción. Un error de persistencia se propaga.

## Validación

- 20 pruebas nuevas con PostgreSQL y Redis reales; proveedor local simulado, sin
  mensajes a personas ni llamadas a Zavu.
- 27 pruebas enfocadas, incluyendo la regresión anterior de outbound.
- Regresión completa de workers (72), conversations (50), WhatsApp y CRM.
- Rol de aplicación sin superusuario/BYPASSRLS: envío válido y rechazo del mensaje
  de otro tenant. Rechazo de plantilla ajena incluso usando conexión administrativa.
- Fallo real de PostgreSQL provocado por trigger limitado al tenant de prueba:
  rollback, ninguna entrega externa y job no confirmado. El trigger se retira.
- Build/typecheck, lint, fronteras de módulos y CI del PR.

## Límites operativos

Esto evita redeliveries de envíos ya confirmados en la base. No promete exactly-once
si el proveedor acepta un mensaje y el proceso cae antes del commit: esa ventana
requiere idempotencia/conciliación del proveedor. Tampoco puede retirar un mensaje
que el proveedor ya recibió cuando llega un opt-out concurrente.

No activa proveedores ni cambia credenciales. No cambia endpoints ni esquemas.
La excepción transaccional sigue limitada al silencio (ADR-0016). Se corrige en la
skill la frase que eximía respuestas manuales de la ventana, contraria al SPEC.
