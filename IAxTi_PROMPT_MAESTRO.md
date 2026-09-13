# IAxTi — Prompt maestro

Documento único de producto, negocio y arquitectura. Se pega completo como primer
mensaje en Claude Code sobre un repositorio vacío y después vive en `docs/SPEC.md`.
Todo lo que no está aquí se pregunta antes de asumirlo. Versión 1.0 · septiembre
2026 · producto de VoxTi Labs · interfaz según el sistema de diseño Pulso.

Actúa como Principal Architect + Staff Engineer + Product Lead. El equipo somos tú
y yo, con dos personas ocasionales. Cada decisión se toma pensando en una persona
que mantiene esto sola y necesita salir a vender en la semana 11.

---

## Índice

**Parte A — Producto y negocio**
1. Qué es IAxTi y qué no es
2. Para quién
3. Dolores y cómo los resolvemos
4. Promesa y principios de producto
5. Lo que es hoy y lo que será
6. Modelo comercial
7. Onboarding
8. Reglas transversales del negocio

**Parte B — Módulos con su lógica**
9. Núcleo: identity · organizations · authorization · audit
10. crm
11. conversations
12. channels · whatsapp · webchat
13. agents
14. knowledge
15. automations
16. calendar
17. payments
18. integrations
19. analytics
20. billing
21. notifications
22. platform (SuperAdmin)
23. Matriz de permisos por rol base
24. Catálogo de eventos

**Parte C — Fundamentos técnicos**
25. Stack y decisiones cerradas
26. Repositorio y sistema de módulos
27. Multi-tenancy, datos y autorización
28. API, colas, observabilidad, infraestructura
29. Interfaz: sistema Pulso
30. Compliance

**Parte D — Ejecución**
31. Roadmap por fases con funciones
32. Claude Code, skills y disciplina de contexto
33. Fase 0: lo que haces ahora
34. Antes de cualquier PR

---

# Parte A — Producto y negocio

## 1. Qué es IAxTi y qué no es

IAxTi es un CRM conversacional para pymes que ya venden por WhatsApp. Junta todas
las conversaciones del negocio en una bandeja compartida, las convierte en
contactos y oportunidades, y pone una IA a trabajar para el dueño: arma el CRM en
15 minutos, sugiere respuestas, califica, agenda en Google Calendar y cobra con un
link de pago sin salir del chat.

**Es:** la bandeja donde el negocio atiende, el lugar donde queda todo lo que se
habló con cada cliente, y un asistente que hace el trabajo repetitivo con permiso.

**No es:** un bot que vende solo (los grandes ya prometen eso y las pymes le tienen
miedo), una herramienta de envíos masivos (atrae al peor cliente y arriesga el
número), una agencia de implementación (el onboarding lo hace la IA, no un
consultor), ni un CRM de escritorio con WhatsApp pegado (el chat es el centro, no un
plugin).

## 2. Para quién

Negocios de 1 a 15 personas donde WhatsApp es el canal principal de venta y
atención, y donde hoy el teléfono lo maneja una persona o se comparte a mano.

### Personas

| Persona | Quién es | Qué necesita de IAxTi |
|---|---|---|
| Dueño/a | Decide, paga, atiende cuando falta gente | Ver todo desde el celular, que nada se pierda, saber cuánto vende y cuánto gasta |
| Vendedor/a | Atiende chats todo el día | Responder rápido, no perder el hilo, que la IA le adelante el trabajo |
| Supervisor/a | Coordina 2 a 6 personas | Repartir conversaciones, ver quién responde tarde, cubrir ausencias |
| Administrativo/a | Cobra, agenda, confirma | Ver pagos y citas sin entrar a tres sistemas |

### Verticales de lanzamiento

Cada vertical tiene una plantilla que el configurador usa como punto de partida:
pipeline, campos, etiquetas, respuestas rápidas, automatizaciones y plantillas de
WhatsApp ya redactadas.

| Vertical | Pipeline típico | Lo que más usa |
|---|---|---|
| Clínicas y consultas | Consulta → Agendado → Atendido → Control | Agenda, recordatorios, cobro de reserva |
| Inmobiliarias y corredores | Interesado → Visita → Oferta → Cerrado | Calificación, visitas en agenda, seguimiento largo |
| Talleres y servicio técnico | Ingreso → Diagnóstico → Presupuesto → Listo → Entregado | Estados con aviso automático, cobro al retirar |
| Tiendas con despacho | Consulta → Pedido → Pagado → Despachado | Catálogo en conocimiento, link de pago, seguimiento de envío |
| Servicios profesionales | Contacto → Reunión → Propuesta → Aceptada | Agenda, propuesta como adjunto, cobro por hito |
| Academias y cursos | Interesado → Inscrito → Pagado → Cursando | Calificación, cobro, recordatorios de clase |

Fuera de alcance en v1: empresas con más de 15 usuarios, call centers, retail
multi-sucursal con más de tres locales, cualquiera que necesite integración con ERP.

## 3. Dolores y cómo los resolvemos

| Dolor concreto | Cómo se ve hoy | Qué hace IAxTi |
|---|---|---|
| Mensajes sin responder | Llegan 40 chats, se contestan 25, los otros se enfrían | Bandeja con "sin responder" arriba, SLA visible, la IA responde fuera de horario si el dueño lo activa |
| Nadie sabe qué se habló | El chat está en el celular de alguien que ya no trabaja ahí | Toda conversación queda en la ficha del contacto, para siempre, exportable |
| Seguimiento que no se hace | "Le escribo mañana" y no se escribe | Seguimientos programados por etapa; la IA redacta, el humano aprueba o se envía solo según regla |
| Agendar es un ping-pong | "¿Te acomoda el jueves?" cinco veces | La IA ofrece horarios reales de Calendar y reserva |
| Cobrar cuesta más que vender | Transferencia, comprobante por foto, conciliación a mano | Link de pago desde el chat; el pago marca la oportunidad como pagada solo |
| No se sabe si el negocio va bien | Sensación, no datos | Embudo, tiempo de respuesta, ventas por vendedor, sin configurar nada |
| Miedo al bot | "Va a decir cualquier cosa" | La IA sugiere por defecto; el modo autónomo es opt-in por horario y con reglas de escalamiento |

## 4. Promesa y principios de producto

**Promesa:** el CRM de WhatsApp que se arma solo y trabaja para el dueño.

Principios, en orden de prioridad cuando chocan:

1. **Nada se pierde.** Ningún mensaje, contacto ni pago queda fuera del sistema.
   Antes de cualquier feature bonita, esto.
2. **El humano manda.** La IA propone; el humano dispone. El modo autónomo existe,
   se activa a propósito y se puede apagar en un toque.
3. **Se arma solo.** Si el usuario tiene que leer un manual, fallamos. El
   configurador hace el trabajo y muestra lo que hizo.
4. **Honestidad en el costo.** Meta, IA y plan se ven separados, en pesos, en tiempo
   real. Sin sorpresas a fin de mes.
5. **Celular primero.** El dueño opera desde el teléfono. Todo funciona a 360 px.
6. **Sin lock-in.** Número propio, exportación total en un clic, datos en Chile si
   los piden.

## 5. Lo que es hoy y lo que será

### v1 · Lanzamiento (fin de fase 4)

WhatsApp + webchat · bandeja compartida · contactos y oportunidades · pipelines por
vertical · configurador IA · copiloto con sugerencias · modo autónomo por horario ·
base de conocimiento · seguimientos programados · Google Calendar · links de pago ·
Drive y Gmail · analytics básico · exportación · un plan por negocio.

### v2 · Con clientes pagando

Instagram y Messenger · automatizaciones avanzadas (secuencias multi-paso) ·
envíos segmentados con opt-in en el plan mayor · roles personalizados · API pública
con keys · webhooks salientes · evaluación continua de agentes · Tech Provider propio
si el volumen lo justifica.

### v3 · Cuando lo pidan

Multi-sucursal · inventario simple · boleta/factura electrónica vía proveedor ·
llamadas de voz con IA · marketplace de plantillas por vertical · residencia de
datos dedicada para clientes que lo exijan.

Nada de v2 o v3 se construye antes de tiempo. Se documenta en el roadmap con la
condición que lo activa.

## 6. Modelo comercial

Un plan por negocio, usuarios ilimitados, nunca por lead ni por conversación. Los
tres planes se diferencian por capacidad y módulos, no por asientos. Aquí no van
precios: se definen fuera del código y el sistema los lee de la configuración de
planes del SuperAdmin.

| | Base | Crece | Equipo |
|---|---|---|---|
| Para quién | 1 a 2 personas | 3 a 6 | 7 a 15 |
| Canales | WhatsApp + webchat | + Instagram, Messenger (v2) | igual |
| Números de WhatsApp | 1 | 2 | 5 |
| Conversaciones activas / mes | tope del plan | tope mayor | tope mayor |
| Cuota de IA / mes | incluida, con tope | mayor | mayor, ampliable |
| Módulos | crm, conversations, agents (copiloto), calendar, payments | + automations completo, knowledge ampliado, integrations | + roles custom, API, webhooks, analytics avanzado, envíos segmentados |
| Retención de conversaciones | 12 meses | 24 meses | ilimitada |
| Soporte | WhatsApp, horario hábil | WhatsApp prioritario | WhatsApp prioritario + persona asignada |

Reglas del modelo:

- **Prueba gratis 14 días** con el número real del cliente conectado y todos los
  módulos de Crece. Sin tarjeta. Al terminar, pasa a Base o elige plan; nada se
  borra durante 30 días más.
- **Costos de Meta** se muestran tal cual los cobra Kapso/Meta, por conversación y
  categoría, en la pantalla de consumo y en la ficha de cada conversación. Sin
  margen escondido. El plan los incluye hasta un tope; sobre el tope, se cobran al
  costo con aviso previo.
- **Cuota de IA** medida en ejecuciones y tokens, mostrada como "asistencias" para
  el usuario y como tokens y pesos para el dueño. Al 80 % avisa; al 100 % el
  copiloto sigue sugiriendo pero el modo autónomo se pausa hasta ampliar o esperar
  el ciclo. Nunca se corta la bandeja.
- **Subir de plan** es inmediato y prorrateado. **Bajar** aplica al siguiente ciclo;
  si el plan nuevo no incluye un módulo activo, el módulo pasa a solo lectura, no
  se borra.
- **Impago:** 7 días de gracia con aviso, después el tenant pasa a solo lectura
  (se reciben mensajes, no se envían salvo respuestas manuales), a los 30 días se
  suspende, a los 90 se ofrece exportación y se elimina.
- **Cancelación** en un clic desde la app, con exportación completa antes.

## 7. Onboarding

Diez minutos, sin humanos de nuestro lado. Cada paso se puede saltar y retomar.

1. **Registro** con Google o correo. Nombre, negocio, rubro (elige vertical o "otro").
2. **Conversación con el configurador.** Tres preguntas máximo: cómo vende, qué pasa
   después de que alguien escribe, cómo cobra. Con eso propone pipeline, campos,
   etiquetas, respuestas rápidas y tres automatizaciones. Muestra el "antes" (cómo
   trabaja hoy, en sus palabras) y el "después" (el CRM propuesto). Un botón: "Armar
   mi CRM". Todo se puede editar después.
3. **Conectar WhatsApp.** Link de setup de Kapso: el cliente entra con Facebook y
   conecta su número en 5 minutos. Si aún no tiene WhatsApp Business, el flujo lo
   guía. Mientras tanto, el webchat ya funciona.
4. **Conocimiento.** Sube un PDF, pega el catálogo o escribe sus tres preguntas más
   frecuentes con respuesta. Opcional, pero el copiloto lo pide cuando no sabe algo.
5. **Equipo.** Invita por correo o WhatsApp con rol sugerido. Opcional.
6. **Primera conversación.** Le pedimos que se escriba a sí mismo desde otro
   teléfono. Ve llegar el mensaje, ve la sugerencia del copiloto, envía. Ahí termina
   el onboarding y empieza la prueba.

Estado de onboarding por tenant: `registered → configured → whatsapp_connected →
knowledge_added → team_invited → first_message → active`. El dashboard muestra el
siguiente paso pendiente hasta llegar a `active`.

## 8. Reglas transversales del negocio

Aplican en todos los módulos.

- **Zona horaria** del tenant, por defecto `America/Santiago`. Toda hora se guarda
  en UTC y se muestra en la del tenant.
- **Teléfonos** en E.164. Un contacto se identifica por teléfono dentro del tenant;
  dos contactos con el mismo teléfono se fusionan con confirmación.
- **RUT** validado con dígito verificador, opcional, en mono.
- **Moneda** CLP por defecto; UF admitida en inmobiliarias y servicios; siempre con
  el valor del día registrado en la transacción.
- **Horario hábil** por tenant (por defecto lunes a viernes 9:00–19:00, sábado
  10:00–14:00). Define cuándo la IA asiste y cuándo puede actuar sola.
- **Horario de silencio:** entre 21:00 y 8:00 no se envía nada iniciado por el
  negocio (recordatorios, seguimientos, plantillas), salvo respuesta a un cliente
  que escribió. Configurable, no desactivable por completo.
- **Ventana de 24 horas de WhatsApp:** dentro de las 24 h desde el último mensaje
  del cliente se puede responder libremente; fuera, solo con plantilla aprobada por
  Meta. La bandeja lo muestra siempre y bloquea el envío libre fuera de ventana.
- **Consentimiento:** un contacto puede recibir mensajes iniciados por el negocio
  solo si escribió primero o dio opt-in registrado (fecha, canal, evidencia).
  "BASTA", "STOP", "no me escriban" y equivalentes marcan opt-out automático.
- **Un dueño por oportunidad** y uno por conversación. Reasignar deja rastro.
- **Nada se borra físicamente** desde la interfaz: se archiva. El borrado real es
  por solicitud del titular o por política de retención, y queda auditado.
- **Idioma:** español de Chile, tuteo, sin jerga técnica para el usuario.

---

# Parte B — Módulos con su lógica

Cada módulo se describe con el mismo esquema: propósito, entidades, reglas,
estados, permisos, eventos, tools que expone a la IA, pantallas, qué pasa apagado
y plan mínimo. El detalle de estructura de carpetas y manifiesto está en la sección 26.

## 9. Núcleo: identity · organizations · authorization · audit

No se apagan nunca. Todo lo demás depende de ellos.

### identity

- **Entidades:** `User` (id, email, nombre, teléfono, avatar, locale, mfa_enabled),
  `Session`, `Invitation` (tenant, email o teléfono, rol, expira en 7 días).
- **Reglas:** un usuario puede pertenecer a varios tenants con roles distintos.
  Login con Google o correo con enlace mágico; contraseña opcional. MFA obligatorio
  para ADMIN y SUPERADMIN desde el segundo usuario del tenant. Cinco intentos
  fallidos bloquean 15 minutos y avisan al ADMIN.
- **Permisos:** `users.read`, `users.invite`, `users.manage`.
- **Eventos:** `user.registered`, `user.invited`, `user.joined_tenant`, `user.login_failed`.

### organizations

- **Entidades:** `Tenant` (id, nombre, rubro, zona horaria, horario hábil, horario
  de silencio, plan, estado, onboarding_state), `Branch` (sucursal, v3), `Team`
  (grupo de usuarios para asignación), `PlanLimits` (topes vigentes),
  `UsageMeter` (conversaciones, IA, storage, por ciclo).
- **Reglas:** el tenant nace en `trial` con fecha de fin. Estados:
  `trial → active → past_due → read_only → suspended → deleted`. Los medidores se
  actualizan por evento y se consolidan cada hora. Cambiar de plan recalcula
  límites y activa o pasa a solo lectura los módulos afectados (sección 6).
- **Permisos:** `tenant.read`, `tenant.settings`, `tenant.billing`, `teams.manage`.
- **Eventos:** `tenant.created`, `tenant.plan_changed`, `tenant.state_changed`,
  `usage.threshold_reached` (80 %, 100 %).

### authorization

- **Entidades:** `Role` (base o custom, por tenant), `Permission` (generado desde
  manifiestos), `RolePermission`, `ApiKey` (v2: scopes, expira, último uso).
- **Reglas:** los roles base no se editan; se clonan para crear custom. Un usuario
  tiene un rol por tenant. Las verificaciones son siempre módulo activo + permiso +
  tenant + objeto cuando aplica (sección 27). El catálogo se regenera al arrancar y
  nunca se escribe a mano.
- **Permisos:** `roles.read`, `roles.manage`, `apikeys.manage`.
- **Eventos:** `role.created`, `role.assigned`, `permission.denied` (a seguridad).

### audit

- **Entidades:** `AuditEntry` append-only con actor, actor_kind (`user`, `agent`,
  `system`, `superadmin`, `apikey`), tenant, action, resource, resource_id,
  timestamp, ip, user_agent, result, request_id, metadata, hash previo.
- **Reglas:** toda mutación que cambie estado de negocio escribe una entrada en la
  misma transacción. Las acciones de agentes registran además `on_behalf_of` (el
  usuario) y `execution_id`. Sin UPDATE ni DELETE por el rol de aplicación.
  Retención según plan; exportación firmada.
- **Permisos:** `audit.read`, `audit.export`.

## 10. crm

**Propósito:** que cada persona que escribió al negocio exista como contacto con
historia, y que cada intención de compra sea una oportunidad con etapa y dueño.

**Entidades**

- `Contact`: teléfono E.164 (clave), nombre, correo, RUT, empresa, dueño, etiquetas,
  campos custom, canales conocidos, consentimiento (opt-in/opt-out con evidencia),
  origen (whatsapp, webchat, importado, manual), última actividad.
- `Company`: nombre, RUT, contactos, campos custom. Opcional; no todos los rubros
  la usan.
- `Pipeline`: nombre, etapas ordenadas, vertical de origen. Un tenant puede tener
  varios (ventas y postventa, por ejemplo).
- `Stage`: nombre, orden, tipo (`open`, `won`, `lost`), probabilidad opcional,
  días esperados (para alertar estancamiento).
- `Deal` (oportunidad): contacto, pipeline, etapa, valor y moneda, dueño, fecha
  esperada, motivo de pérdida, conversación de origen, pagos asociados.
- `Activity`: llamada, reunión, tarea, nota; con vencimiento y responsable.
- `CustomField`: por entidad, tipo (texto, número, fecha, lista, sí/no, moneda),
  requerido o no, visible para la IA o no.
- `Tag`: por tenant, con color de rol Pulso (nunca decorativo).

**Reglas de negocio**

- Al llegar un mensaje de un teléfono desconocido se crea el contacto y una
  conversación; la oportunidad no se crea sola, la crea el usuario o la IA con
  sugerencia ("parece que quiere cotizar, ¿creo la oportunidad?").
- Un contacto tiene a lo más una oportunidad abierta por pipeline. Cerrar en `won`
  o `lost` permite abrir otra.
- Cambiar de etapa hacia atrás pide motivo. Cerrar en `lost` pide motivo de una
  lista configurable.
- Una oportunidad en la misma etapa más días de los esperados se marca
  "estancada" y aparece en el resumen del supervisor.
- Fusionar contactos conserva ambas historias y todos los identificadores; deja
  rastro en audit y no se deshace automáticamente.
- Importación por CSV con mapeo de columnas, validación de teléfonos y vista
  previa. Los importados nacen sin opt-in.
- El valor de una oportunidad en UF guarda también el valor en pesos al día.

**Permisos:** `crm.contacts.read/create/update/merge/export`,
`crm.deals.read/create/update/close`, `crm.pipelines.manage`, `crm.fields.manage`,
`crm.activities.manage`. `USER` ve solo sus contactos y oportunidades salvo que el
ADMIN habilite "ver todo el equipo".

**Eventos:** `contact.created`, `contact.updated`, `contact.merged`,
`contact.opted_out`, `deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`,
`deal.stalled`, `activity.due`.

**Tools para la IA:** `crm.find_contact`, `crm.create_contact`, `crm.update_contact`,
`crm.create_deal`, `crm.move_deal`, `crm.add_note`, `crm.create_task`,
`crm.get_history`. Ninguna borra.

**Pantallas:** ficha de contacto (historia unificada, oportunidades, actividades,
acciones de la IA), tablero Kanban por pipeline, lista con filtros guardados,
importación.

**Apagado:** los contactos siguen existiendo como identidad de conversación mínima
(teléfono y nombre) dentro de `conversations`; oportunidades, pipelines y campos
no se muestran. Se usa para un cliente que solo quiere bandeja.

**Plan mínimo:** Base.

## 11. conversations

**Propósito:** una bandeja donde el equipo atiende todos los canales, sabe qué
está pendiente y nunca deja a alguien sin respuesta.

**Entidades**

- `Conversation`: contacto, canal, cuenta de canal, estado, dueño, equipo,
  prioridad, último mensaje entrante (para la ventana de 24 h), primera respuesta,
  etiquetas, oportunidad vinculada.
- `Message`: dirección (in/out), tipo (texto, imagen, audio, documento, ubicación,
  contacto, plantilla, interactivo), contenido, adjuntos, estado de entrega
  (`queued → sent → delivered → read → failed`), autor (usuario, agente, sistema),
  id del proveedor, costo Meta cuando aplica.
- `InternalNote`: visible solo para el equipo, con menciones.
- `QuickReply`: atajo con variables (`{nombre}`, `{monto}`), por tenant o por usuario.
- `Assignment`: historial de dueños con motivo.

**Estados de conversación**

```
new        llegó y nadie la tomó
open       tiene dueño, en curso
pending    esperando al cliente
resolved   cerrada por el equipo, se reabre sola si el cliente escribe
snoozed    pospuesta hasta una fecha
```

**Reglas de negocio**

- Asignación configurable por tenant: manual, round-robin por equipo, al último
  que atendió a ese contacto, o a la IA en horario autónomo. `new` sin dueño por
  más de N minutos (configurable, 10 por defecto) avisa al supervisor.
- SLA de primera respuesta por tenant (30 minutos por defecto en horario hábil).
  La bandeja ordena por "más tiempo sin responder" y muestra el contador.
- La ventana de 24 h se calcula desde el último mensaje entrante. Fuera de ventana
  el campo de texto se reemplaza por el selector de plantillas.
- Audios entrantes se transcriben (si el módulo agents está activo) y la
  transcripción queda como texto buscable.
- Adjuntos se guardan en Cloud Storage por tenant; los de WhatsApp se descargan al
  llegar porque Meta los expira.
- Una conversación `resolved` que recibe mensaje vuelve a `open` con el mismo
  dueño si está disponible, o a `new`.
- Búsqueda de texto completo por tenant sobre mensajes y notas.
- Cuando la IA responde sola, el mensaje muestra "respondió el asistente" para el
  equipo; el cliente ve el nombre configurado del asistente y siempre puede pedir
  humano.

**Permisos:** `conversations.read` (propias), `conversations.read_all`,
`conversations.reply`, `conversations.assign`, `conversations.resolve`,
`conversations.notes`, `quickreplies.manage`.

**Eventos:** `conversation.created`, `conversation.assigned`,
`conversation.state_changed`, `message.received`, `message.sent`,
`message.failed`, `sla.first_response_breached`, `conversation.handoff_requested`.

**Tools para la IA:** `conversations.get_context` (últimos N mensajes, ficha,
oportunidad), `conversations.suggest_reply` (interno), `conversations.send_reply`
(solo en modo autónomo o tras confirmación), `conversations.set_state`,
`conversations.request_handoff`.

**Pantallas:** bandeja de tres paneles (lista, chat, ficha), vista "mi cola" y
"sin responder", filtros por estado, dueño, canal, etiqueta.

**Apagado:** no aplica para un tenant activo; es el corazón del producto. Se puede
apagar a nivel plataforma solo con kill-switch, que deja la API en solo lectura.

**Plan mínimo:** Base.

## 12. channels · whatsapp · webchat

**Propósito:** conectar cada canal detrás del mismo contrato para que la bandeja y
la IA no sepan de dónde viene un mensaje.

**Entidades**

- `ChannelAccount`: tipo, tenant, nombre visible, estado (`connecting`, `active`,
  `degraded`, `disconnected`), credenciales referenciadas (nunca en claro).
- `WhatsAppNumber`: phone_number_id, waba_id, número, calidad (`green/yellow/red`
  según Meta), límite de mensajería, nombre verificado.
- `Template`: nombre, categoría (`utility`, `marketing`, `authentication`), idioma,
  cuerpo con variables, estado de aprobación (`draft → submitted → approved /
  rejected`), motivo de rechazo.
- `WebchatWidget`: dominio permitido, colores desde tokens Pulso del tenant,
  mensaje de bienvenida, horario.

**Reglas de negocio**

- WhatsApp conecta por link de setup de Kapso; el número es del cliente. Un tenant
  tiene tantos números como su plan permita.
- Webhooks verifican firma, se encolan en `inbound` y responden 200 en menos de
  un segundo. El procesamiento es idempotente por id de mensaje del proveedor.
- Envíos salen por la cola `outbound` con rate limit por número y reintento
  exponencial; un `failed` definitivo aparece en la bandeja con causa legible
  ("el número no tiene WhatsApp", "fuera de ventana y sin plantilla").
- Las plantillas se crean desde IAxTi, se envían a aprobación y solo se pueden
  usar en `approved`. Las de vertical vienen pre-redactadas. El configurador propone
  las tres más útiles y las envía a aprobar en el onboarding.
- Calidad del número en `red` pausa automáticamente todo envío iniciado por el
  negocio y avisa al ADMIN.
- El webchat usa el mismo modelo de conversación; el visitante se identifica con
  nombre y teléfono o correo antes del segundo mensaje.
- Instagram y Messenger (v2) son adaptadores nuevos del mismo contrato; nada de la
  bandeja cambia.

**Permisos:** `channels.read`, `channels.connect`, `channels.manage`,
`templates.manage`.

**Eventos:** `channel.connected`, `channel.degraded`, `channel.disconnected`,
`template.approved`, `template.rejected`, `number.quality_changed`.

**Tools para la IA:** `channels.list_templates` (aprobadas), `channels.send_template`
(con confirmación o en autónomo dentro de reglas).

**Pantallas:** conexión de canales, estado del número, gestor de plantillas con
vista previa, instalación del webchat (snippet).

**Apagado:** `whatsapp` apagado deja las conversaciones históricas visibles y
bloquea envíos; `webchat` apagado desactiva el widget. `channels` nunca se apaga.

**Plan mínimo:** Base.

## 13. agents

**Propósito:** poner una IA a trabajar para el negocio sin quitarle el control.

**Entidades**

- `Agent`: nombre visible para el cliente, personalidad (tono, largo, formalidad),
  idioma, modelo, versión de prompt (Langfuse), tools permitidas, base de
  conocimiento, modo por defecto, horario autónomo, reglas de escalamiento, límites.
- `Execution`: agente, conversación, usuario en cuyo nombre actúa, entrada,
  decisión, tools llamadas, salida, tokens, costo, latencia, resultado, trace de
  Langfuse, explicación legible.
- `Suggestion`: propuesta de respuesta o acción pendiente de aprobación, con
  confianza y expiración.
- `Feedback`: pulgar arriba/abajo del usuario sobre una sugerencia o respuesta,
  con motivo opcional.

**Los tres agentes**

| Agente | Entrada | Salida | Actúa solo |
|---|---|---|---|
| Configurador | Descripción del negocio, vertical | Pipeline, campos, etiquetas, respuestas rápidas, automatizaciones, plantillas, como diff | Nunca: siempre propone y el usuario aplica |
| Copiloto | Cada mensaje entrante y el contexto | Sugerencia de respuesta, resumen, intención, calificación, acciones (agendar, crear oportunidad, enviar link) | Solo en horario autónomo o si la conversación está marcada "atiende la IA", y dentro de las reglas de escalamiento |
| Conocimiento | Pregunta del cliente o del equipo | Respuesta con cita al documento | Es una herramienta de los otros dos |

**Modos de operación por conversación**

```
assist      la IA sugiere, el humano envía            (por defecto)
autonomous  la IA responde sola dentro de reglas       (por horario o manual)
off         la IA no interviene en esta conversación   (el humano la apaga)
```

**Reglas de escalamiento (la IA pasa a humano y lo avisa)**

- El cliente pide hablar con una persona, en cualquier forma.
- Pregunta por precio, stock, plazo o condición que no está en el conocimiento.
- Detecta enojo, reclamo, amenaza legal o mención de un pago no reconocido.
- La conversación lleva más de N turnos autónomos sin avanzar (5 por defecto).
- Cualquier acción con dinero (link de pago sobre un monto configurable) o con
  compromiso de fecha fuera de la disponibilidad real.
- Confianza de la sugerencia bajo el umbral del tenant.

**Guardrails no negociables**

- Nunca inventa precios, stock, plazos ni descuentos. Si no está en el conocimiento,
  dice que lo confirma con el equipo y escala.
- Nunca promete lo que una tool no confirmó (no dice "agendado" si Calendar no
  respondió).
- Nunca envía mensajes iniciados por el negocio fuera del horario de silencio.
- Nunca usa datos de otro tenant ni de otro contacto del mismo tenant salvo los
  de la conversación actual.
- Toda acción queda explicada en la ficha: qué hizo, con qué tool, por qué.
- Cada respuesta autónoma lleva el nombre del asistente y la opción de pedir humano.

**Cuota y costo**

- Cada ejecución descuenta de la cuota del tenant y registra tokens y costo
  estimado. Se muestra al usuario como asistencias y al dueño como pesos.
- Al 100 % de cuota: `assist` sigue con un modelo más barato si existe; `autonomous`
  se pausa y todas las conversaciones vuelven a `assist` con aviso.

**Evaluación**

- Dataset de regresión por agente con casos reales anonimizados, corrido en CI
  antes de cambiar versión de prompt o modelo.
- LLM-as-judge sobre correctness, tono y selección de tool; feedback humano desde
  la bandeja alimenta el dataset.
- Un agente no pasa a producción con score menor al de la versión anterior.

**Permisos:** `agents.read`, `agents.configure`, `agents.execute`,
`agents.set_mode`, `agents.view_costs`.

**Eventos:** `agent.executed`, `agent.suggested`, `agent.acted`, `agent.escalated`,
`agent.failed`, `agent.quota_threshold`.

**Pantallas:** configuración del asistente (personalidad, horario, reglas,
conocimiento), panel de sugerencias en la bandeja, registro de acciones en la
ficha, consumo.

**Apagado:** la bandeja funciona sin sugerencias, las transcripciones de audio se
detienen, las automatizaciones que usan IA se pausan con aviso.

**Plan mínimo:** Base (copiloto en assist). Autónomo desde Crece.

## 14. knowledge

**Propósito:** que la IA responda con lo que el negocio dice, no con lo que se
imagina.

- **Entidades:** `Source` (PDF, texto pegado, URL, FAQ estructurada, catálogo CSV),
  `Chunk` (texto, embedding, fuente, página), `Faq` (pregunta, respuesta, vigencia).
- **Reglas:** un source tiene vigencia opcional (precios que vencen); vencido, la
  IA lo ignora y avisa. El catálogo CSV se indexa por producto con precio y stock
  como campos, no como prosa. Toda respuesta con conocimiento incluye la cita.
  Embeddings en pgvector con `tenant_id` y RLS. Reindexación al cambiar la fuente.
- **Permisos:** `knowledge.read`, `knowledge.manage`.
- **Eventos:** `knowledge.updated`, `knowledge.source_expired`.
- **Tools:** `knowledge.search`, `knowledge.get_product`.
- **Apagado:** la IA responde solo con el contexto de la conversación y escala más.
- **Plan mínimo:** Base (hasta N fuentes); ampliado en Crece.

## 15. automations

**Propósito:** que el seguimiento que hoy no se hace, se haga.

- **Entidades:** `Rule` (nombre, disparador, condiciones, acciones, estado,
  horario), `Sequence` (cadena de pasos con esperas: "día 1 mensaje, día 3 si no
  respondió plantilla, día 7 tarea al vendedor"), `Run` (ejecución de una regla
  sobre un objeto, con resultado).
- **Disparadores:** eventos del catálogo (sección 24) más tiempo ("2 días en etapa",
  "1 hora antes de cita", "sin respuesta hace 24 h").
- **Condiciones:** sobre el objeto (etapa, etiqueta, valor, campo custom, canal,
  opt-in, horario).
- **Acciones:** enviar plantilla o mensaje (dentro de ventana), crear tarea, mover
  etapa, etiquetar, asignar, avisar al equipo, pedir a la IA que redacte, crear
  evento en Calendar, enviar link de pago. Las acciones disponibles se calculan
  desde los módulos activos.
- **Reglas:** ninguna acción de mensaje sale fuera del horario de silencio ni sin
  consentimiento; se difiere al siguiente horario válido. Una regla que falla tres
  veces sobre el mismo objeto se detiene para ese objeto y avisa. Una regla cuya
  acción depende de un módulo apagado se pausa con aviso. Las secuencias se cortan
  solas cuando el cliente responde o la oportunidad cambia de etapa. Vista previa
  "a quién le aplicaría hoy" antes de activar.
- **Permisos:** `automations.read`, `automations.manage`.
- **Eventos:** `automation.ran`, `automation.failed`, `automation.paused`.
- **Tools:** `automations.create_rule`, `automations.list_rules` (el configurador
  las usa).
- **Apagado:** las secuencias en curso se detienen y las reglas quedan guardadas.
- **Plan mínimo:** Base (tres reglas), completo en Crece.

## 16. calendar

**Propósito:** agendar desde el chat con horarios reales.

- **Entidades:** `CalendarConnection` (usuario, Google, tokens referenciados),
  `Availability` (por usuario o equipo: días, horas, duración, buffer, anticipación
  mínima), `Appointment` (contacto, usuario, inicio, fin, estado, oportunidad,
  evento de Google, recordatorios enviados).
- **Estados:** `proposed → confirmed → reminded → attended / no_show / cancelled /
  rescheduled`.
- **Reglas:** la disponibilidad cruza el calendario real de Google (free/busy) con
  la configurada. La IA ofrece máximo tres horarios. Confirmar crea el evento en
  Google con el contacto como invitado si tiene correo. Recordatorio 24 h y 2 h
  antes por plantilla (dentro del horario de silencio se difiere). Reagendar y
  cancelar desde el chat ("¿puedo cambiarla?") con confirmación. `no_show` se
  marca a mano o por automatización; dispara seguimiento si hay regla.
- **Permisos:** `calendar.read`, `calendar.connect`, `calendar.book`,
  `calendar.manage_availability`.
- **Eventos:** `appointment.created`, `appointment.reminder_sent`,
  `appointment.attended`, `appointment.no_show`, `appointment.cancelled`.
- **Tools:** `calendar.get_slots`, `calendar.book`, `calendar.reschedule`,
  `calendar.cancel`.
- **Apagado:** la acción "agendar" desaparece del copiloto y de las reglas; las
  citas existentes quedan visibles.
- **Plan mínimo:** Base.

## 17. payments

**Propósito:** cobrar desde el chat y saber, sin conciliar a mano, qué se pagó.

- **Entidades:** `PaymentProvider` (Webpay, Flow, Mercado Pago; credenciales
  referenciadas), `PaymentLink` (monto, moneda, concepto, oportunidad, contacto,
  vence, estado), `Payment` (link, monto pagado, medio, fecha, id del proveedor,
  comprobante).
- **Estados del link:** `created → sent → paid / expired / cancelled`. Un link
  pagado es inmutable.
- **Reglas:** el monto se toma de la oportunidad o se escribe; la IA solo puede
  generar links hasta el monto máximo configurado y siempre con confirmación salvo
  regla explícita. El webhook del proveedor confirma el pago, marca el link,
  registra el `Payment`, avisa en la conversación con comprobante y, si la
  oportunidad lo tiene configurado, la mueve a la etapa de pagado. Reembolsos y
  disputas se registran pero se resuelven en el proveedor. Montos en mono siempre.
- **Permisos:** `payments.read`, `payments.create_link`, `payments.manage_providers`.
- **Eventos:** `payment_link.sent`, `payment.received`, `payment.failed`,
  `payment_link.expired`.
- **Tools:** `payments.create_link`, `payments.get_status`.
- **Apagado:** no se generan links; el historial de pagos sigue visible.
- **Plan mínimo:** Base.

## 18. integrations

**Propósito:** que IAxTi viva dentro de las herramientas que la pyme ya usa.

- **Google Drive:** adjuntar archivos de Drive a una conversación o ficha; guardar
  adjuntos recibidos en una carpeta por contacto si el usuario lo activa; la IA
  puede leer documentos autorizados como conocimiento.
- **Gmail:** mostrar en la ficha los hilos de correo con ese contacto (solo lectura
  en v1); enviar correo desde la ficha en v2.
- **Webhooks salientes (v2):** por evento del catálogo, firmados HMAC, con panel de
  entregas y reintentos.
- **API pública (v2):** las mismas rutas de la sección 28 con API key y scopes.
- **Reglas:** OAuth incremental por usuario; tokens en Secret Manager; scopes
  mínimos; revocación desde la app; cada acceso a datos de Google queda en audit.
- **Permisos:** `integrations.read`, `integrations.connect`, `integrations.manage`,
  `webhooks.manage`.
- **Eventos:** `integration.connected`, `integration.revoked`, `webhook.failed`.
- **Tools:** `drive.search`, `drive.attach`, `gmail.get_threads`.
- **Plan mínimo:** Crece.

## 19. analytics

**Propósito:** que el dueño sepa cómo va el negocio sin configurar un reporte.

- **Métricas de v1, todas por rango de fechas y por usuario:** conversaciones
  nuevas, tiempo de primera respuesta (mediana y p90), sin responder ahora,
  resueltas, oportunidades creadas, tasa de cierre por etapa, valor ganado, citas
  agendadas y asistidas, pagos recibidos, uso y costo de IA, costo de Meta por
  categoría.
- **Reglas:** se calculan desde eventos en tablas agregadas por día y tenant, no
  con consultas pesadas en vivo. Todo número muestra su definición al pasar el
  cursor. Sin métricas inventadas ni proyecciones.
- **Permisos:** `analytics.read` (propio), `analytics.read_all`.
- **Apagado:** el dashboard muestra solo el resumen de la bandeja.
- **Plan mínimo:** Base (básico); avanzado en Equipo.

## 20. billing

**Propósito:** cobrarle a la pyme por IAxTi de forma clara y automática.

- **Entidades:** `Subscription` (plan, ciclo, estado, próximo cobro),
  `UsageRecord` (consolidado por ciclo), `Invoice` (líneas: plan, exceso de Meta,
  ampliación de IA; estado), `PaymentMethod`.
- **Reglas:** ciclo mensual; cobro con el mismo proveedor de pagos que usamos para
  los clientes; la factura muestra los tres costos separados; los estados del
  tenant de la sección 6 se aplican desde aquí. Boleta o factura electrónica
  chilena vía proveedor en v3; en v1 se emite manualmente con los datos que
  billing genera.
- **Permisos:** `billing.read`, `billing.manage` (solo ADMIN).
- **Eventos:** `invoice.issued`, `invoice.paid`, `invoice.overdue`,
  `subscription.changed`.
- **Plan mínimo:** todos.

## 21. notifications

- **Canales:** en la app (campana), correo, push web y móvil (v2), WhatsApp al
  propio equipo para avisos críticos (número del negocio a sus usuarios, opt-in).
- **Tipos:** conversación nueva sin dueño, mención en nota, SLA por vencer, tarea
  vencida, pago recibido, cita próxima, cuota de IA, número en calidad baja,
  factura.
- **Reglas:** cada usuario elige por tipo y canal; los críticos (número en rojo,
  impago) no se pueden silenciar para el ADMIN. Agrupación para no inundar.
- **Permisos:** `notifications.manage_own`.
- **Apagado:** solo a nivel plataforma.

## 22. platform (SuperAdmin)

Aplicación aparte, mismos módulos, permisos `platform.*`, todo cross-tenant y todo
auditado con `actor_kind = superadmin`.

- **Tenants:** lista con estado, plan, uso, salud de canales; crear, suspender,
  reactivar, cambiar plan, extender prueba, entrar en modo soporte (lectura, con
  aviso al tenant y en audit).
- **Planes:** definir límites y módulos por plan sin desplegar; precios viven aquí.
- **Módulos:** habilitar, deshabilitar, kill-switch, versión, dependencias, health,
  tenants que lo usan.
- **Centro de IA:** ejecuciones, éxito, latencia, tokens y costo por tenant, agente,
  modelo y día; navegación tenant → conversación → ejecución → trace de Langfuse;
  versiones de prompt activas; scores de evaluación.
- **Seguridad:** logins fallidos, permisos denegados, IPs bloqueadas, abuso de API,
  webhooks fallidos, números en calidad baja.
- **Audit:** explorador global con todos los filtros.
- **Salud:** api, workers, agents, Postgres, Redis, colas, Kapso, Google, Gemini,
  proveedor de pagos.
- **Permisos:** `platform.tenants`, `platform.plans`, `platform.modules`,
  `platform.ai`, `platform.security`, `platform.audit`, `platform.health`.

## 23. Matriz de permisos por rol base

| Capacidad | USER | SUPERVISOR | ADMIN | SUPERADMIN |
|---|---|---|---|---|
| Ver y responder sus conversaciones | ✓ | ✓ | ✓ | soporte |
| Ver todas las conversaciones del tenant | según config | ✓ | ✓ | soporte |
| Asignar y reasignar | — | ✓ | ✓ | — |
| Crear y editar contactos y oportunidades propias | ✓ | ✓ | ✓ | — |
| Ver todo el CRM | según config | ✓ | ✓ | soporte |
| Fusionar contactos, exportar | — | ✓ | ✓ | — |
| Editar pipelines, campos, etiquetas | — | — | ✓ | — |
| Usar el copiloto | ✓ | ✓ | ✓ | — |
| Configurar el asistente, modo autónomo, reglas | — | — | ✓ | — |
| Ver consumo y costo de IA | — | ✓ | ✓ | ✓ |
| Crear links de pago | ✓ hasta tope | ✓ | ✓ | — |
| Configurar proveedores de pago y canales | — | — | ✓ | — |
| Automatizaciones | — | ver | ✓ | — |
| Calendario propio | ✓ | ✓ | ✓ | — |
| Disponibilidad del equipo | — | ✓ | ✓ | — |
| Invitar usuarios y roles | — | — | ✓ | — |
| Roles personalizados (v2) | — | — | ✓ | — |
| Analytics | propio | equipo | todo | todo |
| Billing y plan | — | — | ✓ | ✓ |
| Audit del tenant | — | — | ✓ | ✓ |
| Plataforma, planes, módulos, kill-switch | — | — | — | ✓ |

"Según config" es un interruptor del ADMIN: "los usuarios ven todo el equipo".

## 24. Catálogo de eventos

Todo evento lleva sobre: `id`, `name`, `tenant_id`, `occurred_at`, `actor`,
`request_id`, `version`, `payload`. Se publican por outbox, se consumen por nombre.

```
identity        user.registered · user.invited · user.joined_tenant · user.login_failed
organizations   tenant.created · tenant.plan_changed · tenant.state_changed · usage.threshold_reached
authorization   role.created · role.assigned · permission.denied
crm             contact.created · contact.updated · contact.merged · contact.opted_out
                deal.created · deal.stage_changed · deal.won · deal.lost · deal.stalled · activity.due
conversations   conversation.created · conversation.assigned · conversation.state_changed
                message.received · message.sent · message.failed
                sla.first_response_breached · conversation.handoff_requested
channels        channel.connected · channel.degraded · channel.disconnected
                template.approved · template.rejected · number.quality_changed
agents          agent.executed · agent.suggested · agent.acted · agent.escalated
                agent.failed · agent.quota_threshold
knowledge       knowledge.updated · knowledge.source_expired
automations     automation.ran · automation.failed · automation.paused
calendar        appointment.created · appointment.reminder_sent · appointment.attended
                appointment.no_show · appointment.cancelled
payments        payment_link.sent · payment.received · payment.failed · payment_link.expired
integrations    integration.connected · integration.revoked · webhook.failed
billing         invoice.issued · invoice.paid · invoice.overdue · subscription.changed
```

Agregar un evento es editar el manifiesto del módulo que lo publica y esta lista.

---

# Parte C — Fundamentos técnicos

Condensados. Cada punto tiene su ADR; si algo aquí te parece mal, contradíceme
antes de implementar.

## 25. Stack y decisiones cerradas

| Área | Decisión | Diferido, con condición |
|---|---|---|
| Lenguaje | TypeScript de punta a punta | — |
| Frontend | Next.js + Tailwind + shadcn/ui tematizado con Pulso | — |
| Backend | NestJS, monolito modular | Microservicios: nunca por moda |
| Agentes | Vercel AI SDK + Chat SDK (adaptador Kapso) + tools MCP | ADK/Python: no |
| Datos | Supabase Cloud (región São Paulo): Postgres + pgvector, RLS, Auth (Google, MFA), Realtime, PITR | Postgres en el VPS vía Dokploy solo si el costo obliga; Cloud SQL o dedicado si un cliente exige residencia |
| Cómputo | Docker → **VPS con Dokploy**: api, workers, agents desde una imagen construida en GitHub Actions y publicada en GHCR | Segundo VPS → Docker Swarm multi-nodo (Dokploy) → Cloud Run / GKE + Helm. Misma imagen en todas las etapas (sección 36) |
| Colas | BullMQ sobre Redis (contenedor Dokploy con AOF) | Redis gestionado cuando haya más de un nodo |
| WhatsApp | Kapso detrás de `ChannelProvider` con vocabulario de Meta | Tech Provider propio cuando el margen de Kapso lo justifique |
| LLM | Gemini vía Vertex AI | Segundo proveedor por configuración del agente |
| Observabilidad | Sentry + OpenTelemetry → Grafana Cloud + Langfuse Cloud | Langfuse self-hosted por contrato |
| Borde | Cloudflare delante de Vercel y Cloud Run | — |
| IaC y CI | Terraform (un proyecto GCP por ambiente) + GitHub Actions | — |

## 26. Repositorio y sistema de módulos

Monorepo con pnpm workspaces y Turborepo:

```
apps/        web · admin · api · workers · agents
packages/    core · db · ui · sdk · modules/<id>
infra/       docker · terraform · helm
docs/        SPEC.md · ARCHITECTURE.md · adr/ · SECURITY_BASELINE.md
             COMPLIANCE_BASELINE.md · IMPLEMENTATION_PLAN.md
.claude/     rules · commands · agents · hooks · skills
CLAUDE.md
```

Cada módulo en `packages/modules/<id>/` tiene `module.yaml`, `contract.ts`,
`domain/`, `application/`, `infrastructure/`, `api/`, `events/`, `tools/`,
`migrations/`, `tests/`.

```yaml
module:
  id: automations
  version: 1.0.0
  core: false
depends_on:
  required: [identity, organizations, crm, conversations]
  optional: [calendar, payments, whatsapp, agents]
permissions: [automations.read, automations.manage]
events:
  publishes: [automation.ran, automation.failed, automation.paused]
  consumes: [conversation.created, deal.stage_changed, appointment.created, message.received]
tools: [automations.create_rule, automations.list_rules]
nav: [{ label: Automatizaciones, path: /automations, permission: automations.read }]
widgets: [{ id: automations.summary, permission: automations.read }]
plan_min: base
flag: module.automations
```

Reglas del sistema de módulos:

1. Un módulo importa de otro solo a través de su `contract.ts`. `dependency-cruiser`
   lo verifica en CI y falla el PR.
2. El Module Registry lee los manifiestos al arrancar, construye el grafo, valida
   ciclos y colisiones, inicializa en orden topológico y expone `GET /health/modules`.
3. Dos interruptores: plataforma (SuperAdmin: instalado, habilitado, kill-switch)
   y tenant (Admin: activado según plan y flag).
4. No se apaga un módulo del que otro activo depende como `required`; el registro
   bloquea y dice qué apagar primero.
5. Apagado para un tenant: endpoints responden `MODULE_DISABLED`; navegación y
   widgets desaparecen (`GET /me/modules`); tools no se registran; jobs se saltan.
   Los datos no se tocan. Desinstalar es acción aparte con exportación previa.
6. Eventos por outbox transaccional, consumidores idempotentes, publicador ciego.
7. Dependencias opcionales por `capabilities.get()`; null degrada, no rompe.
8. Núcleo que nunca se apaga: identity, organizations, authorization, audit.
9. Test de combinación en CI: cada módulo solo con sus `required`; la app con
   todo apagado menos el núcleo.

## 27. Multi-tenancy, datos y autorización

```
Tenancy       shared schema · tenant_id en toda tabla de negocio · RLS con
              SET app.tenant_id · cache y logs y eventos con tenant_id
Migraciones   por módulo, versionadas, aditivas; borrar o renombrar en dos pasos
Backups       Supabase PITR · restore probado cada mes · RPO 5 min · RTO 1 h
Autorización  @RequireModule + @RequirePermission + tenant + objeto
              roles como paquetes de permisos; nunca if (role === 'ADMIN')
              catálogo generado desde manifiestos; tools de IA por el mismo guard
Audit         append-only, hash encadenado, misma transacción que la mutación
PII           minimización en logs, redacción antes de Langfuse, borrado por
              solicitud con registro, exportación total del tenant
```

## 28. API, colas, observabilidad, infraestructura

```
API           REST · OpenAPI 3.1 desde código en /docs · /v1 · cursor (máx 100)
              ?filter[x]=&sort=-y · Idempotency-Key en POST que crea o cobra
              X-Request-Id propagado · rate limit por tenant y key en Redis
              error único { code, message, requestId, details[] } con voz Pulso
Colas         inbound · outbound · automations · sync · scheduled · agents
Observab.     Sentry (errores) · OTel → Grafana Cloud (plataforma) · Langfuse (IA)
              mismo trace_id de punta a punta; trazas con tenant, user,
              conversation, agent, session, request
Alertas       error rate · p95 · webhooks fallidos · cola atascada ·
              costo de IA por tenant fuera de rango · número en calidad roja
Infra         local (compose) · dev · staging · prod · un proyecto GCP cada uno
              Cloud Run ×3 · Memorystore · Cloud Storage · Secret Manager
              Cloudflare → Vercel (web, admin) y → Cloud Run (api)
CI            lint → typecheck → dependency-cruiser → unit → integration →
              contract → module-combinations → CodeQL → Gitleaks → Trivy →
              Checkov → build → deploy dev; staging desde main; prod con aprobación
GitHub        Issue → feat/<issue>-<slug> → PR con plantilla → checks → review
              → squash → release (conventional commits, semver, changelog)
              CODEOWNERS por módulo · branch protection · Dependabot semanal
```

## 29. Interfaz: sistema Pulso

IAxTi usa Pulso tal cual está en su documento. Lo que el código debe cumplir:

- Tokens de día y noche en `packages/ui/pulso-tokens.css`; modo con
  `<html data-mode="dia|noche">`, inicial por `prefers-color-scheme`, persistido
  por usuario. Tailwind apunta a variables; nunca `dark:`. shadcn tematizado:
  botón 999, campo 14, tarjeta 22, control 46 px, sin sombras, Outfit / Inter /
  JetBrains Mono.
- Ningún componente sabe en qué modo está. Ningún hex suelto. Tres superficies.
  Un botón primario por vista. Mono en montos, UF, RUT, fechas, plazos, ids.
  Etiquetas con `--{rol}-soft` y `--{rol}-text`; el color nunca es el único
  significado. Avisos: qué pasó y qué hacer. Estados vacíos: qué va a aparecer y
  la acción que lo provoca. Foco visible. 360 px sin scroll horizontal.
- Producto: bandeja de tres paneles (lista `--bg-raised`, chat `--bg`, ficha
  `--bg-raised`; apilados en celular). Sugerencia del copiloto como aviso
  `action-soft` sobre el campo con un primario "Enviar sugerencia". Acciones de la
  IA en la ficha con rótulo mono ("AGENDÓ", "ENVIÓ LINK") y explicación en
  `--text-body`. Configurador con el dispositivo antes/después de Pulso. Costos en
  mono, siempre visibles. Ventana de 24 h como etiqueta `warn` cuando quedan menos
  de 2 h y `bad` cuando cerró.
- Marca: lockup de VoxTi Labs inline (`voxti-tokens.svg`) en el SuperAdmin y en el
  pie de la app cliente. IAxTi sin marca propia por ahora: nombre como texto en
  Outfit 800, no como logo.
- Antipatrones sin excepción: gradientes, sombras, morado y violeta, verde
  principal, blanco puro nocturno, negro puro, glassmorphism, emoji en interfaz,
  iconos de cohete o rayo o cerebro, contadores animados, copy de relleno,
  métricas inventadas.

## 30. Compliance

Tres cosas que no se confunden: preparación técnica (lo que el código hace),
certificación formal (ISO 27001 / 27701 / 42001: políticas, responsable,
evidencia, auditoría externa; meses; no es código) y cumplimiento legal (Ley
21.719: base de licitud, derechos del titular, contratos de tratamiento con cada
cliente, notificación de brechas).

`COMPLIANCE_BASELINE.md` mantiene la matriz
`Control · ISO 27001 · ISO 27701 · ISO 42001 · OWASP ASVS · Ley 21.719 ·
Implementación · Tipo (técnico / organizacional / legal / contractual) · Estado`.
Cada feature que toque datos personales o IA actualiza su fila. Nunca se escribe
"cumple ISO" en el producto ni en material comercial.

---

# Parte D — Ejecución

## 31. Roadmap por fases con funciones

| Fase | Semanas | Qué queda funcionando | Criterio de salida |
|---|---|---|---|
| 0 Discovery | — | Este documento, ADRs, CLAUDE.md, `.claude/`, issues | Mi aprobación |
| 1 Fundación | 1–3 | Monorepo, registro de módulos, núcleo (identity, organizations, authorization, audit), RLS, OpenAPI, CI completo, Cloud Run + Terraform en dev | Test de combinación verde; un tenant de prueba con dos usuarios y roles |
| 2 CRM núcleo | 4–7 | crm, conversations (sin canal real), quick replies, web y admin con Pulso en día y noche, importación CSV | Un supervisor asigna una conversación simulada y la resuelve desde el celular |
| 3 IA + WhatsApp | 8–11 | channels + whatsapp (Kapso) + webchat, agents (copiloto assist y autónomo por horario, configurador), knowledge, notifications, Langfuse, cuota | **Demo vendible:** onboarding completo en 10 minutos con número real |
| 4 Agenda y cobro | 12–14 | calendar, payments, automations (tres reglas + secuencias básicas), integrations (Drive, Gmail lectura), analytics básico, billing con planes | Primer cliente en prueba gratis |
| 5 Crecimiento | con feedback | SuperAdmin completo, roles custom, Instagram y Messenger, automatizaciones avanzadas, envíos segmentados, API y webhooks, evaluación continua | Diez clientes pagando |
| 6 Hardening | con volumen | Load testing, DR probado, matriz de compliance completa, Tech Provider si conviene, GKE si un cliente lo exige | Primer cliente que pida contrato de tratamiento de datos |

Al terminar la fase 3 se sale a vender. Nada de fase 5 se adelanta.

## 32. Claude Code, skills y disciplina de contexto

**CLAUDE.md** contiene en forma operativa: principios (sección 4 y reglas
transversales de la 8), sistema de módulos (26), patrón de autorización (27),
formato de error (28), reglas de interfaz (29), comandos de desarrollo, y la
instrucción de leer `docs/SPEC.md` y el ADR del área antes de tocarla.

**.claude/**

```
rules/      arquitectura · módulos · seguridad · testing · api · db · git · ui-pulso · negocio
commands/   /new-module · /new-adr · /security-review · /module-check · /ui-check · /rule-check
agents/     reviewer-arquitectura · reviewer-seguridad · reviewer-pulso · reviewer-negocio
hooks/      pre-commit: lint, typecheck, dependency-cruiser, gitleaks
skills/     iaxti-module · iaxti-permissions · iaxti-channel-provider
            iaxti-compliance · iaxti-pulso · iaxti-business-rules
```

`reviewer-negocio` y `/rule-check` verifican que un PR no viole las reglas de la
sección 8 (ventana de 24 h, silencio, consentimiento, un dueño, nada se borra).

**Skills externas, instalar antes de empezar.** Oficiales de Anthropic
(`@claude-plugins-official`): `skill-creator`, `mcp-builder`, `frontend-design`,
`webapp-testing`. De Matt Pocock (`mattpocock/skills`, en el marketplace oficial):
`setup-matt-pocock-skills`, `grill-me`, `wayfinder`, `to-prd`, `to-issues`,
`triage`, `handoff`, `zoom-out`, `improve-codebase-architecture`, `tdd`,
`domain-model`.

```bash
npx skills@latest add mattpocock/skills \
  --skill setup-matt-pocock-skills --skill grill-me --skill wayfinder \
  --skill to-prd --skill to-issues --skill triage --skill handoff \
  --skill zoom-out --skill improve-codebase-architecture --skill tdd \
  --skill domain-model -y
```

```
/plugin install skill-creator@claude-plugins-official
/plugin install mcp-builder@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install webapp-testing@claude-plugins-official
```

Verifica los nombres con `/plugin` antes de instalar. Las seis skills `iaxti-*`
no existen; se crean con `skill-creator` en la fase 0.

**Disciplina de contexto:** `/wayfinder` al inicio de cada fase; `/domain-model`
antes de escribir el primer módulo de negocio de cada fase; `/zoom-out` antes de
cualquier cambio que cruce módulos; `/handoff` al cerrar cada sesión larga, y la
siguiente empieza leyendo el handoff, no el historial.

## 33. Fase 0: lo que haces ahora

No escribas código de producto.

1. `/setup-matt-pocock-skills` (issue tracker: GitHub).
2. `/grill-me` sobre este documento entero. Pregúntame lo que necesites cerrar,
   con tu respuesta recomendada en cada pregunta. Prioriza las ambigüedades de
   negocio (secciones 6, 8, 11, 13) sobre las técnicas.
3. `/domain-model` sobre las secciones 10 a 17: entrega el modelo de dominio con
   entidades, relaciones e invariantes, y señala contradicciones entre módulos.
4. Genera `docs/ARCHITECTURE.md` con Mermaid: infraestructura, sistema de
   módulos, permisos, flujo de un mensaje de WhatsApp de punta a punta (webhook →
   cola → conversación → copiloto → sugerencia → envío → estado), flujo del
   configurador, flujo de un pago, ciclo de vida del tenant.
5. Genera `docs/adr/0001` a `0010`: stack TypeScript · Supabase como datos e
   identidad · Cloud Run antes que GKE · BullMQ antes que Pub/Sub · Kapso ahora y
   Tech Provider después · Langfuse + OpenTelemetry · sistema de módulos · modelo
   de autorización · Pulso como sistema de diseño · modo assist por defecto y
   autónomo opt-in.
6. Genera `docs/SECURITY_BASELINE.md`, `docs/COMPLIANCE_BASELINE.md` con la matriz
   de la sección 30 poblada con los controles de este documento, y
   `docs/IMPLEMENTATION_PLAN.md` por semanas según la 31, con las funciones de
   cada módulo (secciones 9 a 22) repartidas por semana.
7. Genera `CLAUDE.md` y `.claude/` según la sección 32, y crea las seis skills
   `iaxti-*` con `skill-creator`.
8. `/to-issues` sobre la fase 1 del plan, como tracer bullets con dependencias.
9. `/handoff` y detente. Espera mi aprobación antes de la fase 1.

## 34. Antes de cualquier PR

1. ¿El cambio vive en un módulo o cruza solo por `contract.ts` y eventos?
2. ¿Todo endpoint nuevo tiene `@RequireModule`, `@RequirePermission` y OpenAPI?
3. ¿Toda mutación importante escribe en `audit_log` en la misma transacción?
4. ¿Hay `tenant_id` en toda tabla nueva y política RLS que lo use?
5. ¿La migración es aditiva y versionada?
6. ¿Hay tests, incluido el de combinación si tocaste un manifiesto?
7. ¿Toda tool nueva pasa por el guard con la identidad del usuario y no borra?
8. ¿Respeta ventana de 24 h, horario de silencio y consentimiento?
9. ¿La IA puede inventar precio, stock, plazo o compromiso con este cambio?
10. ¿Algún hex suelto, sombra, gradiente o emoji en la interfaz?
11. ¿Se ve bien en día y noche, a 360 px, con el foco visible, montos en mono?
12. ¿Algún secret, token o URL interna en el diff?
13. ¿El ADR existe si la decisión es importante? ¿La matriz de compliance está al día?
14. ¿El PR referencia su issue y el título sigue conventional commits?
