# Baseline de compliance

Tres cosas distintas que no se confunden (SPEC §30):

1. **Preparación técnica** — lo que el código hace. Se rastrea aquí.
2. **Certificación formal** — ISO 27001/27701/42001: políticas, responsable,
   evidencia, auditoría externa. Meses. No es código.
3. **Cumplimiento legal** — Ley 21.719: base de licitud, derechos del titular,
   contratos de tratamiento, notificación de brechas.

**Nunca se afirma "cumple ISO" en el producto ni en material comercial.** La
arquitectura es auditable; la certificación es un proceso aparte.

Cada feature que toque datos personales o IA actualiza su fila. Tipo:
técnico (T) / organizacional (O) / legal (L) / contractual (C).

| Control | ISO 27001 | ISO 27701 | ISO 42001 | OWASP ASVS | Ley 21.719 | Implementación | Tipo | Estado |
|---|---|---|---|---|---|---|---|---|
| Control de acceso por roles y permisos | A.5.15, A.8.3 | 6.2 | — | V4 | art. seguridad | ADR-0008, #9 | T | hecho — guard único, ADR-0008; el CI falla si aparece un `if (role)` |
| Scopes de identidades de servicio | A.5.15 | 6.2 | — | V4 | art. seguridad | #24, #388 | T | el guard y las comprobaciones internas exigen el scope explícito de la API key; un permiso fuera del catálogo, un comodín o un rol humano adjunto no amplían su alcance |
| MFA para administradores | A.5.17 | — | — | V2.8 | — | #7 | T | **pendiente** — Supabase Auth está, el segundo factor no |
| Aislamiento multi-tenant (guard + RLS) | A.8.3 | 6.4 | — | V4.2 | deber de secreto | #4, #9, #211 | T | hecho, **con una condición**: Postgres no evalúa las políticas si el rol que conecta es superusuario o tiene BYPASSRLS. La aplicación comprueba eso al arrancar y en producción se niega a servir si no se cumple (#227). En Supabase el rol `postgres` tiene BYPASSRLS: el runbook exige un rol de aplicación aparte |
| Auditoría append-only con integridad | A.8.15 | 6.9 | 8.4 | V7 | evidencia | #10, #375 | T | hash encadenado, trigger anti UPDATE/DELETE, explorador y export firmado (#72). El escritor normaliza metadata como jsonb antes del hash para conservar la verificación al releer; no reescribe hashes históricos ni oculta alteraciones |
| Campañas revisadas antes del envío | A.8.15 | 7.2 | — | V4, V7 | consentimiento y evidencia | #356 | T | pantalla con conteo y muestra, bloqueo por calidad roja/desconocida y pausa; revalida antes de enviar. Creación y envío registrados en auditoría en sus transacciones; el backend conserva consentimiento, plantillas aprobadas y cola con horario de silencio |
| Despacho durable de mensajes | A.8.15 | 6.9 | — | V4, V7 | evidencia | #380, ADR-0020 | T | emisores de API, agente, automatizaciones y comprobantes con outbox transaccional, auditoría, ID estable y recuperación autorizada; probados rollback, aislamiento, Redis sin respuesta y reinicio. No garantiza exactly-once frente al proveedor externo |
| Reservas y estados de agenda consistentes | A.8.15 | 6.9 | — | V4, V7 | evidencia | #373 | T | reservas serializadas por tenant/responsable; transiciones revalidadas bajo bloqueo. Cita, auditoría y evento en la misma transacción; concurrencia y rol sin BYPASSRLS probados |
| Actividades CRM con identidad de servicio | A.5.15, A.8.15 | 6.4 | — | V4.2, V7 | evidencia | #346 | T | contacto y oportunidad validados dentro del tenant; la API key queda en audit como `apikey`, sin inventar un responsable humano. Creación y auditoría comparten transacción; regresiones cubren aislamiento, rollback, permisos e idempotencia |
| Tablas y etiquetado en lote | A.8.15 | 7.2 | — | V4, V7 | trazabilidad de cambios | #299 | T | orden y cursor en servidor con contexto de tenant/filtros; lote aditivo, permisos, validación de ids del tenant, auditoría y outbox en la misma transacción; sin borrado desde interfaz |
| Superficie expuesta por el proveedor de base | A.8.9 | 6.5 | — | V13 | minimización | `blindarEsquema` en cada migración (#456) | T | hecho — Supabase publica TODO el esquema `public` por su API de datos con la llave anónima del navegador, y sus privilegios por defecto alcanzan a cada tabla NUEVA. Las 65 tablas por tenant estaban tapadas por RLS; diez no, porque no son de un tenant —entre ellas `tenants`, `user_profiles` y `platform_admins`—. Ahora cada corrida de migraciones quita los permisos de `anon` y `authenticated`, enciende RLS en todo y deja una política restrictiva que los niega aunque alguien vuelva a conceder. Única excepción: `SELECT` de `authenticated` sobre `user_roles`, que la política de Realtime necesita para comprobar pertenencia (#37) |
| Cifrado en tránsito y reposo | A.8.24 | 6.5 | — | V9 | seguridad | ADR-0002/0003 | T | hecho por proveedor — TLS y cifrado en reposo de Supabase, R2 y Cloudflare |
| Gestión de secretos y rotación | A.8.24 | — | — | V6 | — | SECURITY_BASELINE | T/O | parcial — todo por referencia y fuera de git; la rotación del cierre de construcción está pendiente |
| Backups y restore probado | A.8.13 | — | — | — | disponibilidad | #80 | T/O | **pendiente** — #80; el restore no se ha cronometrado nunca |
| Minimización de PII en logs y trazas | A.8.11 | 6.11 | 8.2 | V8 | proporcionalidad | ADR-0006 | T | hecho — ADR-0006; nada de cuerpos de mensaje en OTel |
| Redacción de PII hacia observabilidad y evaluación | — | 6.11 | 8.2, 9.2 | — | proporcionalidad | `redactPII` en `runtime.ts` (Langfuse) y en el dataset de evaluación | T | hecho — encendido por defecto, apagable por tenant |
| Contenido del cliente hacia el proveedor LLM | — | 6.11 | 8.2, 9.2 | — | transferencia | inherente al producto; mitigación contractual | L/C | **parcial — dicho como es**: al modelo va el texto REAL de la conversación, sin redactar, porque redactar lo que se le pide interpretar rompe la sugerencia. La redacción protege Langfuse y el dataset, no al proveedor. La mitigación es contractual: tier pago con opt-out de entrenamiento y la fila de transferencia de cada proveedor |
| Transferencia internacional (Supabase, Gemini, Zavu, GLM si se adopta) | A.5.19 | 7.5 | — | — | transferencia internacional | contratos + fila por proveedor | L/C | pendiente |
| Consentimiento y opt-out registrado | — | 7.2 | — | — | base de licitud | #30, #372 | T/L | opt-in con evidencia y opt-out por palabra clave; la cola revalida opt-out, consentimiento, ventana y plantilla antes de entregar, incluso tras una espera. Pruebas con PostgreSQL/Redis y RLS activo |
| Derecho de acceso y portabilidad | — | 7.3 | — | — | derechos del titular | del titular y del tenant | T | hecho — `GET /contacts/:id/titular` entrega todo lo de una persona (mensajes incluidos), y la exportación completa del negocio existe desde #222: sale con lo que dejó afuera y por qué, y jamás un secreto. **Corrección del 22/09/2026**: esto decía «hecho» cuando la ruta no la llamaba NADIE — el derecho estaba implementado y no era ejercible sin abrir una consola. Ya está en la ficha de cada persona (#447) |
| Derecho de supresión | — | 7.3 | — | — | derechos del titular | borrado por solicitud, registrado, todos los módulos | T | hecho — motivo obligatorio; despersonaliza el contacto y borra el contenido en TODAS las tablas donde vivía, incluida la copia que quedaba en las ejecuciones de IA (#235). Lo que se conserva —audit, montos, medición— viaja escrito en el resultado y en el libro. **Corrección del 22/09/2026**: igual que el de acceso, se daba por hecho sin pantalla. Ya se ejerce desde la ficha, con confirmación aparte y el detalle de qué se borró y qué se conservó (#447) |
| Retención definida y aplicada | A.8.10 | 7.4 | — | — | limitación del plazo | ADR-0012, #77 | T | hecho — ADR-0012 y #77, con aviso previo al cambio de plan |
| Notificación de brechas | A.5.24-26 | — | — | — | notificación | procedimiento en SECURITY_BASELINE | O/L | parcial — el procedimiento está escrito; nunca se ha ensayado |
| Contrato de tratamiento con cada cliente | — | 8 | — | — | encargado | plantilla legal (#81) | L/C | **pendiente (legal)** — borrador a revisión de abogado; no lo resuelve el código |
| Transparencia de la IA ante el usuario final | — | — | 8.3 | — | — | "respondió el asistente" + pedir humano (#49) | T | hecho — se declara que respondió el asistente y se puede pedir humano |
| Supervisión humana de la IA | — | — | 8.4, 9.4 | — | — | ADR-0010: assist por defecto, escalamiento | T | hecho — ADR-0010: assist por defecto, autónomo es opt-in |
| Registro y explicación de acciones de IA | — | — | 8.4 | — | — | Execution + explicación en ficha (#47) | T | hecho — Execution con explicación en la ficha |
| Evaluación continua de agentes | — | — | 9.2 | — | — | #53: dataset, judge, gate | T | hecho — dataset de regresión que BLOQUEA el CI si baja del baseline |
| Cuotas y límites de uso de IA | — | — | 8.2 | — | — | #52 | T | hecho — umbrales al 80/100 % y pausa del modo autónomo |
| Análisis estático de seguridad (SAST) | A.8.28 | — | — | V14 | — | Semgrep en el CI (owasp-top-ten, typescript, secrets), BLOQUEA el PR | T | hecho |
| Análisis dinámico (DAST) | A.8.29 | — | — | V14 | — | OWASP ZAP baseline agendado contra staging (`.github/workflows/zap.yml`) | T | parcial — el workflow está; sin staging en pie no ha corrido (#133) |
| Transferencia internacional · Supabase (datos y auth) | A.5.19 | 7.5 | — | — | transferencia internacional | contrato del proveedor + región declarada | L/C | pendiente |
| Transferencia internacional · Google Gemini (IA) | A.5.19 | 7.5 | 8.2 | — | transferencia internacional | ADR-0011 + `redactPII` antes de salir | T/L/C | parcial — lo técnico está; el contrato no |
| Transferencia internacional · Anthropic (IA) | A.5.19 | 7.5 | 8.2 | — | transferencia internacional | `PROVIDERS` incluye `anthropic`; el tenant lo puede elegir por tarea | L/C | pendiente — **no tenía fila y sí es elegible**: cualquier tenant puede ponerlo como proveedor de una tarea y el texto de las conversaciones sale hacia allá igual que con Gemini |
| Transferencia internacional · GLM / NVIDIA (IA) | A.5.19 | 7.5 | 8.2 | — | transferencia internacional | ADR-0025 §7 + `SIN_GARANTIA_DE_DATOS`/`SOLO_TEXTO` en config.ts | T/L/C | parcial — **decisión del dueño (ADR-0025 §7, 25/09/2026): GLM corre en TODAS las tareas de texto y es el proveedor por defecto**, supersede la restricción de ADR-0023. Hecho que lo cambia: la cuenta sirve GLM por el catálogo de NVIDIA (`integrate.api.nvidia.com`, llave `nvapi-`) — el destino de los datos es NVIDIA (EE.UU.), no Zhipu (China). Pendiente contractual: los términos de NVIDIA para nuestra cuenta (uso para entrenamiento, retención, jurisdicción) no se han revisado — mismo estándar que se le exigió a Zhipu. Resguardos vigentes: «solo Gemini» por tenant se ofrece sin discusión; `transcribir` no pasa por GLM (capacidad); el gate de evals decide el fallback. El mecanismo de sin-garantías queda vivo con lista vacía |
| Transferencia internacional · Zavu (canales) | A.5.19 | 7.5 | — | — | transferencia internacional | ADR-0014; el contenido de los mensajes pasa por el proveedor | L/C | pendiente |
| Transferencia internacional · Cloudflare R2 (adjuntos) | A.5.19 | 7.5 | — | — | transferencia internacional | adjuntos por tenant, URLs firmadas de vida corta | L/C | pendiente |
| Separación de ambientes para cobros reales | A.8.31 | — | — | — | — | ADR/SPEC §17, #275, #366 | T | hecho — el modo `live` de un proveedor de pagos se verifica al darlo de alta **y al cobrar**. Se comprobaba solo al alta, y una fila heredada de un respaldo de producción cobraba desde staging (#275). Sin `IAXTI_ENV`, el ambiente es desconocido y desconocido no es producción. Flow valida además el destino oficial contra el modo persistido al crear y consultar pagos; no sigue redirecciones ni habilita credenciales de ejemplo. La validación real del sandbox sigue pendiente en #60 |
| Límite de la autonomía de escritura de la IA | — | — | 8.4, 9.4 | — | — | [ADR-0017](./adr/0017-que-puede-escribir-la-ia.md) | T | hecho — de nueve herramientas que escriben se habilitaron dos, las que quedan adentro del negocio y se deshacen. El criterio (¿lo ve el cliente? ¿se puede deshacer?) y el motivo de cada una de las siete cerradas están en la ADR. Una escritura por generación; el contacto sale de la conversación, no lo elige el modelo |
| Excepción nombrada al horario de silencio | — | 7.2 | — | — | proporcionalidad | [ADR-0016](./adr/0016-mensajes-transaccionales-y-horario-de-silencio.md) | T | hecho — solo el comprobante de pago, porque lo dispara el cliente al pagar. Se salta el silencio y nada más: ni la pausa por calidad, ni el estado del tenant, ni la ventana de 24 h. Un test falla si la lista crece |
| Aviso antes de eliminar los datos de un tenant | A.8.10 | 7.4 | — | — | limitación del plazo | #218 | T | hecho — a los 75 días suspendido se avisa al ADMIN con 15 días para exportar o volver; a los 90 el tenant queda en una cola que **borra una persona**, nunca el sistema. Un test recorre el código buscando quien lo automatice |
| Trazabilidad de extremo a extremo con tenant | A.8.15, A.8.16 | — | — | V7 | evidencia | #17, #272, #369 | T | hecho — la traza sigue del request al job de la cola y cada línea de log lleva su `tenant_id` con `LOG_FORMAT=json`. Sin `OTEL_EXPORTER_OTLP_ENDPOINT` la exportación de trazas queda apagada. Con Sentry y OTLP activos, un único proveedor OTel conserva aislamiento y correlación de errores; las trazas solo se exportan a OTLP, probado con receptores locales (#369) |
| Vigilancia de disponibilidad y alertas | A.8.16 | — | — | — | disponibilidad | #17, #396 | T/O | **parcial** — `/health` y `/ready` en los cinco servicios; Compose raw recibe los checks de vida ausentes de workers/agents. Web/admin verifican API/Auth; workers exige arranque, Redis y PostgreSQL; agents verifica Redis. Las sondas nuevas tienen plazo y errores redactados. Pendientes: recepción real de telemetría en los destinos, Uptime Kuma y las cuatro alertas mínimas (error rate, p95, cola atascada, disco). Procedimiento en `docs/runbooks/OBSERVABILIDAD.md` |
| Inventario de datos personales por módulo | — | 6.1 | — | — | registro de actividades | [INVENTARIO-DATOS.md](./INVENTARIO-DATOS.md) | T/O | hecho — qué guarda cada tabla, de quién es, si se exporta y qué le pasa al suprimir. Un test falla si aparece una tabla sin inventariar, así que no puede quedar viejo en silencio |

Las referencias a cláusulas ISO/ASVS son orientativas para ordenar el trabajo;
la numeración exacta se valida con el auditor cuando la certificación empiece
(Fase 6, #81).

## Cómo se lee el estado

- **hecho** — está construido y hay un test que lo sostiene. Lo puede verificar
  cualquiera leyendo el código.
- **hecho por proveedor** — lo resuelve la infraestructura contratada, no
  nuestro código. Se sostiene con el contrato del proveedor, no con un test.
- **parcial** — una parte está y la otra se nombra explícitamente. Nunca se
  deja en "hecho" algo a medias.
- **pendiente** — no está. Se dice, no se maquilla.
- **pendiente (legal)** — no lo resuelve el código; necesita una persona con
  título de abogado.

Ninguna fila dice "cumple ISO", y ninguna lo dirá: la arquitectura es
auditable, la certificación es un proceso aparte (SPEC §30).

## Lo que falta para responder a un cliente que pide contrato de tratamiento

1. El borrador de contrato revisado por abogado (fila propia, arriba).
2. Las **seis** filas de transferencia internacional con su contrato firmado
   — Supabase, Gemini, Anthropic, GLM, Zavu y R2. Las de Anthropic y GLM se
   agregaron hoy: los dos son proveedores elegibles por cualquier tenant y no
   tenían fila. La de GLM además señala algo que no es solo papeleo — su ADR
   (#54) sigue abierta y el código ya lo acepta.
3. El restore cronometrado (#80) y el ensayo de notificación de brechas.
4. MFA para quien administra (#7).
5. La vigilancia de disponibilidad (#17): sin alertas, "el servicio estuvo
   arriba" es una afirmación sin evidencia.

La 1, la 2 y el ensayo de la 3 no son código. Las demás sí, y están
identificadas con su issue.

### Una cosa que este documento decía mal hasta hoy

Decía que se redacta PII **hacia los proveedores de IA**. No es cierto y no
puede serlo: al modelo hay que darle el texto real de la conversación, porque
redactar justo lo que se le pide interpretar rompe la sugerencia. Lo que
`redactPII` protege es Langfuse y el dataset de evaluación.

Está corregido arriba, en dos filas separadas. Se anota acá porque esta es la
página que se le muestra a un cliente que pide contrato de tratamiento, y una
afirmación de más en este documento vale menos que una de menos.
