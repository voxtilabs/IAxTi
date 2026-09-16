# Inventario de datos personales

Qué guarda cada tabla, de quién es, y qué le pasa cuando alguien ejerce un
derecho. Es el "registro de actividades de tratamiento" que pide la Ley
21.719 y la fila que quedaba pendiente en
[COMPLIANCE_BASELINE.md](./COMPLIANCE_BASELINE.md).

**Este documento no puede quedar desactualizado en silencio**: hay un test
(`packages/db/tests/inventario.test.ts`) que falla si aparece una tabla con
`tenant_id` que no esté acá. Agregar una tabla obliga a decir qué guarda.

## Cómo leer las columnas

- **PII** — ¿guarda datos de una persona identificable? `directa` (nombre,
  teléfono, correo, RUT, contenido de sus mensajes), `indirecta` (identifica
  a través de otra tabla) o `no`.
- **De quién** — del *cliente final* (la persona que le escribe al negocio),
  del *equipo* (quien trabaja en el negocio) o del *negocio*.
- **Exporta** — sale en la exportación del tenant (#222) o del titular.
- **Suprime** — qué le pasa cuando el titular pide su supresión (#235).

## Personas que le escriben al negocio

| Tabla | Qué guarda | PII | De quién | Exporta | Suprime |
|---|---|---|---|---|---|
| `contacts` | nombre, teléfono, correo, RUT, campos propios del negocio, consentimiento y su evidencia | directa | cliente final | sí | se despersonaliza: la fila queda, la persona no |
| `contact_identities` | la identidad por canal (teléfono, id de Instagram) | directa | cliente final | sí | se borran |
| `contact_tags` | qué etiquetas tiene | indirecta | cliente final | sí | se van con el contacto |
| `conversations` | el hilo, sus tiempos y su estado | indirecta | cliente final | sí | queda vacía y archivada: el negocio sabe que hubo un trato |
| `messages` | **el contenido de los mensajes**, adjuntos y transcripciones | directa | cliente final | sí | se borran |
| `internal_notes` | lo que el equipo anota sobre la conversación | directa | ambos | sí | se borran |
| `suggestions` | lo que la IA propuso responder | directa | cliente final | sí | se borran |
| `agent_executions` | **lo que se le mandó al modelo y lo que respondió** | directa | cliente final | sí | se vacía el contenido; queda la medición (tokens, costo) |
| `response_samples` | muestras de tiempos de respuesta | indirecta | negocio | sí | se borran |
| `assignments` | quién atendió qué | indirecta | equipo | sí | quedan |
| `deals` | oportunidades: título, valor, etapa | indirecta | negocio | sí | quedan: registro comercial |
| `deal_stage_history` | el paso por cada etapa | indirecta | negocio | sí | queda |
| `activities` | tareas y notas sobre esa persona | directa | ambos | sí | se borran |
| `appointments` | la cita de una persona: cuándo, con quién y cómo terminó | indirecta | cliente final | sí | se van con el contacto |
| `webchat_sessions` | la sesión del visitante y su nombre si lo dio | directa | cliente final | sí | se van con el contacto |
| `payment_links` | monto, concepto y estado del cobro | indirecta | negocio | sí | se vacía el concepto; montos y fechas quedan por obligación de guarda |
| `payments` | el pago recibido | indirecta | negocio | sí | queda: registro contable |

## El equipo del negocio

| Tabla | Qué guarda | PII | De quién | Exporta | Suprime |
|---|---|---|---|---|---|
| `user_roles` | quién pertenece al negocio y con qué rol | indirecta | equipo | sí | no aplica |
| `invitations` | correo y teléfono de quien se invitó | directa | equipo | sí, **sin el token** | no aplica |
| `teams` | equipos de trabajo | no | negocio | sí | no aplica |
| `notifications` | los avisos de la campana | indirecta | equipo | sí | no aplica |
| `notification_preferences` | qué avisos quiere cada quien | no | equipo | sí | no aplica |
| `push_subscriptions` | las llaves del navegador para el aviso push | indirecta | equipo | **no**: no sirven fuera de ese navegador | no aplica |
| `api_keys` | el **hash** de la credencial, nunca la credencial | no | negocio | **no**: un hash no se exporta | no aplica |

## Configuración y operación del negocio

| Tabla | Qué guarda | PII | De quién | Exporta | Suprime |
|---|---|---|---|---|---|
| `tenants` | el negocio, su plan, su estado y sus ajustes | no | negocio | sí | no aplica |
| `pipelines`, `stages`, `loss_reasons` | la forma del embudo | no | negocio | sí | no aplica |
| `tags`, `custom_fields`, `companies`, `products` | catálogos del negocio | no | negocio | sí | no aplica |
| `quick_replies`, `saved_filters` | atajos del equipo | no | negocio | sí | no aplica |
| `rules`, `rule_runs`, `sequences`, `sequence_enrollments` | automatizaciones y a quién se le aplicaron | indirecta | negocio | sí | quedan |
| `segments` | los filtros de un segmento de la cartera, sin personas adentro | no | negocio | sí | no aplica |
| `campaigns` | la campaña: plantilla, filtros congelados y estado | no | negocio | sí | queda |
| `campaign_recipients` | **a quién se le mandó una campaña y qué pasó con cada uno** | indirecta | cliente final | sí | se van con el contacto |
| `agents`, `agent_conversation_modes` | configuración del copiloto | no | negocio | sí | no aplica |
| `availability` | los horarios que atiende cada persona del equipo | no | negocio | sí | no aplica |
| `whatsapp_templates` | las plantillas aprobadas por Meta y su texto | no¹ | negocio | sí | quedan: son del negocio, no de una persona |
| `sources`, `chunks` | la base de conocimiento y sus trozos indexados | no¹ | negocio | sí | no aplica |
| `channel_accounts`, `whatsapp_numbers`, `webchat_widgets` | canales conectados y **referencias** a credenciales | no | negocio | sí | no aplica |
| `webhook_endpoints` | a dónde avisar, **sin el secreto** | no | negocio | sí, sin el secreto | no aplica |
| `payment_providers` | qué pasarela usa el negocio y la **referencia** a su credencial | no | negocio | sí | no aplica |
| `webhook_deliveries` | lo que se le mandó a un tercero | directa² | cliente final | sí | se vacía el payload |
| `subscriptions`, `invoices` | la suscripción y las facturas | no | negocio | sí | quedan: obligación de guarda |
| `usage_meters`, `daily_metrics` | consumo y métricas agregadas | no | negocio | sí | quedan |
| `custom_fields` | qué campos declara el negocio | no | negocio | sí | no aplica |

¹ Salvo que el negocio suba un documento con datos de personas: ahí el
contenido es responsabilidad suya y la retención la fija su plan.
² El payload lleva el contenido del evento, y eso incluye mensajes.

## Mecánica interna (no es dato del negocio)

| Tabla | Por qué no se exporta |
|---|---|
| `audit_log` | tiene su propia exportación firmada y encadenada (#72) |
| `outbox`, `processed_events` | la cola de eventos: mecánica nuestra |
| `idempotency_keys` | llaves de reintento con vida de 24 h |
| `knowledge_query_cache` | caché: se reconstruye sola |
| `platform_support_sessions` | registro NUESTRO de cuándo miramos la cuenta |
| `eval_cases`, `eval_runs` | nuestras pruebas de calidad del copiloto |
| `agent_quota_alerts` | marcas internas para no avisar dos veces |
| `agent_proposals` | propuestas de configuración del copiloto |
| `roles` | roles custom del tenant (se exportan con `user_roles`) |
| `contact_tags` | se exporta, listada arriba |

## Dónde se guarda

| Dónde | Qué | Región |
|---|---|---|
| Postgres (Supabase) | todo lo de las tablas de arriba | declarada en el proyecto |
| Cloudflare R2 | adjuntos de los mensajes, por tenant | global con URLs firmadas de vida corta |
| Redis | colas y contadores de límite; **sin contenido de mensajes** | el del despliegue |
| Proveedor de canales (Zavu) | el contenido de los mensajes pasa por él | ver ADR-0014 |
| Proveedor de IA | lo que se le manda, con `redactPII` aplicado antes | ver ADR-0011 |
