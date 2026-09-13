# Secciones 39 y 40 para el Prompt maestro de IAxTi

Se pegan al final de la Parte E, después de la sección 38. Mismo formato y voz
que el resto del documento. Al final va la lista de correcciones al texto
existente para que las cuatro versiones del repo dejen de contradecirse.

---

## 39. Retención, cierre automático y borrado de conversaciones

Tres mecanismos distintos que no se confunden. "Inactividad" en una bandeja
significa cerrar, no borrar: una conversación es el historial del contacto y en un
CRM ese historial es el activo. Ninguno se ejecuta desde la interfaz; los tres
corren en `workers`, cola `scheduled`, y quedan en audit.

| Mecanismo | Quién lo configura | Dónde | Qué hace | Por defecto |
|---|---|---|---|---|
| Cierre automático | ADMIN del tenant | Configuración → Conversaciones | `open` o `pending` sin mensaje entrante por N días pasa a `resolved`. No borra nada | 7 días |
| Archivo | ADMIN del tenant | ídem | `resolved` sin actividad por N meses recibe `archived_at`; sale de la bandeja y de los filtros, sigue en búsqueda y en la ficha | 3 meses |
| Retención | SUPERADMIN | Planes (por plan) · Tenant → Plan (override ≤ plan) | Borrado físico de conversación, mensajes, notas, asignaciones y adjuntos con `last_message_at` anterior al corte | Base 12 · Crece 24 · Equipo ilimitada |

Reglas:

- La inactividad se mide con `last_message_at`, en cualquier dirección. Cierre y
  archivo miran además `last_inbound_at` (el que ya existe para la ventana de 24 h).
- La retención borra `Conversation`, `Message`, `InternalNote`, `Assignment` y los
  objetos de R2 asociados. `Contact`, `Deal` y `Appointment` no se tocan. La ficha
  muestra "Conversaciones anteriores eliminadas por la política de retención del
  plan", con la fecha del corte.
- Nunca se borra una conversación en `new`, `open` o `snoozed` aunque supere el
  corte. Primero la cierra el cierre automático; la corrida siguiente la borra.
- Borrado por lotes de 1.000 conversaciones por transacción. Las llaves de R2 se
  leen antes del `DELETE` y se borran después del commit, con reintento idempotente;
  si R2 falla, el job reintenta solo esa parte.
- Una entrada de audit por tenant y por corrida: `actor_kind = system`,
  `action = conversations.retention.purged`, metadata con corte, cantidad y rango de
  ids. No una entrada por conversación: inflaría audit sin agregar información.
- Bajar de plan acorta la retención: el tenant recibe aviso 30 días antes de la
  primera purga con el plazo nuevo, con la cantidad exacta que se borraría. Subir de
  plan no recupera nada.
- Tenants en `trial` vencido, `read_only`, `suspended` o `deleted` no entran aquí:
  los cubre el ciclo de vida de `organizations` (30 días después de la prueba, 90
  días de impago). Es otro job, en otro módulo.
- Módulo `conversations` con kill-switch: el job se salta, como todo job de módulo
  apagado (sección 26, regla 5).
- La solicitud del titular (Ley 21.719) es un flujo aparte: borra todo lo del
  contacto en todos los módulos, en cualquier plan, y deja registro de la solicitud.

Datos:

```
PlanLimits.retention_months           int | null    null = ilimitada
Tenant.settings.retention_months      int | null    override, validado ≤ plan al guardar y al cambiar de plan
Tenant.settings.auto_resolve_days     int           por defecto 7, mínimo 1
Tenant.settings.archive_after_months  int | null    por defecto 3, null desactiva
Conversation.last_message_at          timestamptz   trigger en Message, cualquier dirección
Conversation.last_inbound_at          timestamptz   ya existe
Conversation.archived_at              timestamptz | null   bandera, no un estado nuevo
índices   conversations (tenant_id, state, last_message_at desc)
          conversations (tenant_id, archived_at)
          messages (tenant_id, conversation_id, created_at desc)
```

Jobs (BullMQ, cola `scheduled`, repetibles, zona `America/Santiago`):

```
conversations.auto_resolve    cada hora      por tenant activo
conversations.archive         diario 03:00   por tenant activo
conversations.retention       diario 04:00   por tenant activo con retención finita
```

Cada job padre recorre tenants y encola un job hijo por tenant. Un tenant grande no
bloquea a los demás y los reintentos son por tenant. Métricas por corrida: tenants
procesados, conversaciones cerradas, archivadas y borradas, duración.

Eventos: `conversation.auto_resolved`, `conversation.archived`,
`conversations.retention.purged` (uno por tenant y corrida).

Pantalla del ADMIN, según Pulso: campo de 46 px con el número en JetBrains Mono,
label "Cerrar conversaciones sin respuesta del cliente después de", ayuda en
`--text-muted` con la próxima corrida, un solo botón primario "Guardar", aviso
"Plazo guardado". Lo mismo para el archivo. La retención se muestra en solo lectura
junto al plan: "Tu plan conserva las conversaciones 12 meses".

Pantalla del SUPERADMIN: en Planes, `retention_months` por plan; en Tenant → Plan,
el override con validación y con el conteo de conversaciones que borraría la
próxima corrida, para que nadie ponga 1 y borre un año sin verlo.

Lo que no se hace, y por qué:

- `pg_cron` en Supabase para la purga. El borrado tiene que auditar en la misma
  transacción, borrar en R2 y respetar el kill-switch; eso vive en `workers`, no en
  la base. `pg_cron` queda para tareas puramente de base (refrescar vistas
  materializadas, por ejemplo).
- Particionar `messages` por mes. ADR cuando pase 20 millones de filas; ahí la
  retención pasa a ser `DROP PARTITION` y deja de costar I/O.
- Borrar por "inactividad" en días. Eso es cierre automático; el borrado va en
  meses y por plan.

---

## 40. Costos de la etapa 1 y reglas de eficiencia

Fijos, USD por mes, antes del primer cliente pagando. Precios de septiembre 2026;
se verifican al contratar y se anotan en `docs/COSTS.md` con la fecha.

| Componente | Plan | USD/mes |
|---|---|---|
| VPS 4 vCPU / 8 GB NVMe en São Paulo (Vultr o Akamai) | — | 60–75 |
| Supabase | Pro (prod) + segundo proyecto para staging | 25 + 10 |
| Cloudflare | Free + Access (hasta 50 usuarios) + R2 (10 GB incluidos, luego 0,015/GB) | 0–5 |
| GHCR | Free con política de limpieza: se conservan las últimas 10 imágenes | 0 |
| Langfuse | Hobby; Core desde fase 3, cuando entran evaluaciones y anotación (sección 13) | 0, luego 29 |
| Sentry · Grafana Cloud · Uptime Kuma | Free | 0 |
| Vercel | No se usa: `web` y `admin` corren en el VPS (secciones 28 y 36) | 0 |
| **Total** | | **~100–120 · ~130–150 desde fase 3** |

Variables, con tope por tenant y traspasados al plan (sección 6): tokens de Gemini
y conversaciones de Meta vía Kapso. Son los únicos costos que crecen con los
clientes; todo lo demás es plano hasta la etapa 2 del camino de escalado.

Reglas:

- **VPS y Supabase en la misma región.** Con la base en São Paulo y la API en
  Santiago, cada query paga ~40 ms de ida y vuelta, y una vista de bandeja hace
  decenas. Si el costo obliga, la alternativa coherente es Supabase `us-east` + VPS
  en Ashburn (~20 USD/mes en Hetzner), aceptando ~130 ms para el usuario en Chile.
  Se decide en un ADR; no se mezclan.
- **Supabase Free no se usa ni para staging.** Se pausa a los 7 días sin actividad
  y un staging pausado un lunes cuesta más que 10 USD.
- **Gemini por la Developer API, tier pago, con `@ai-sdk/google`,** hasta que un
  cliente exija Vertex AI por residencia o contrato. Cambiar es cambiar el provider
  en la configuración del agente. Evita proyecto GCP, IAM y credenciales antes de
  que Terraform exista. Nunca el tier gratis: sus condiciones permiten usar los
  datos para entrenamiento y aquí van datos de clientes.
- **Palancas de costo de IA, en orden de impacto:** tamaño del contexto por
  sugerencia (`conversations.get_context` con N pequeño y resumen del resto);
  modelo por tarea (Flash para clasificar, transcribir y sugerir; Pro solo para el
  configurador); cache de la base de conocimiento por tenant; cuota visible al
  80 % y al 100 % (sección 6). Borrar conversaciones viejas no está en esta lista:
  30 tenants activos generan del orden de 1 GB al mes y el GB extra en Supabase
  cuesta 0,125 USD.
- **Realtime de la bandeja por broadcast** desde la API (o `realtime.send` en un
  trigger), nunca por `postgres_changes`: cada cambio se evalúa contra RLS por cada
  suscriptor y el costo crece con tenants × usuarios. Además el frontend no lee
  tablas directamente (sección 25), así que `postgres_changes` rompería esa regla.
- **Adjuntos nunca en Postgres.** R2 desde el día uno; el egress de Supabase
  (250 GB en Pro) es para filas, no para audios.
- **Se mide desde el día uno:** costo de IA por tenant y por día, conversaciones
  de Meta por tenant, tamaño de la base, egress, CPU y memoria por contenedor.
  Alerta si cualquiera crece más de 30 % semana a semana. "Cuándo escalar" es un
  número (sección 38), no una sensación.

---

## Correcciones al documento existente

Antes de pegar el Prompt maestro en Claude Code. Si `/grill-me` encuentra estas
contradicciones, va a preguntar; si no las encuentra, va a asumir una de las dos
versiones.

1. **`IAxTi_SPEC.md` e `IAxTi_prompt_claude_code.md`** describen Cloud Run,
   Memorystore y Terraform desde la fase 1. El Prompt maestro (1) los reemplaza por
   VPS con Dokploy y Terraform diferido. Dejar solo el maestro en el repo, o
   regenerar los otros dos desde él. `IAxTi_PROMPT_MAESTRO.md` sin "(1)" es una
   versión anterior sin la Parte E: borrarla.
2. **Sección 25, fila Borde:** "Cloudflare delante de Vercel y Cloud Run" pasa a
   "Cloudflare delante del VPS". `web` y `admin` ya son contenedores en las
   secciones 28 y 36.
3. **Sección 33, punto 5:** el ADR "Cloud Run antes que GKE" pasa a "VPS con
   Dokploy antes que la nube, con las condiciones de la sección 38". Agregar
   "Gemini Developer API antes que Vertex AI" y "cierre, archivo y retención de
   conversaciones" si se aceptan las secciones 39 y 40. Quedan 0001 a 0012.
4. **Sección 36, topología:** "región más cercana a Chile disponible: Santiago, São
   Paulo o Miami" pasa a "la misma región que el proyecto de Supabase".
5. **Sección 6, fila Retención, y sección 8, "Nada se borra físicamente":** agregar
   "ver sección 39".
6. **Sección 11, entidad `Conversation`:** agregar `last_message_at` y
   `archived_at`. No se agrega un estado `archived`: es una bandera sobre
   `resolved`, para no tocar la máquina de estados ni la regla de reapertura.
7. **Sección 22, Planes:** agregar `retention_months` a lo que se define por plan
   sin desplegar.
8. **Sección 31, roadmap:** cierre automático y archivo entran en la fase 2 con la
   bandeja; el job de retención entra en la fase 5, porque hasta los 12 meses del
   primer tenant no borra nada y no bloquea la salida a vender.
