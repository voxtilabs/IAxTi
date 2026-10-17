# Variables del compose y degradación al faltar (#810 C1)

Medición estática del árbol `79936e77bfa57ebcfbcc16b81888af2fdb9983c7` (staging), realizada el 16 de octubre. No se cargó ningún `.env` ni se leyó configuración de Dokploy. No es una observación del despliegue: describe lo que permite el archivo y cómo responde el código de esa revisión.

## Conteo reproducible

Desde la raíz: `node docs/evidencias/810/medir-compose.mjs`. El resultado completo, sin valores, está en [variables.json](variables.json). El script cuenta interpolaciones activas, omite líneas comentadas y falla ante operadores no contemplados. Su alcance es la sintaxis presente en estos dos archivos, no un parser general de Compose.

| Archivo | Variables distintas | Obligatorias por alguna aparición `:?` | Sin ninguna aparición `:?` | Apariciones totales | Apariciones sin `:?` |
| --- | ---: | ---: | ---: | ---: | ---: |
| prod | 45 | 12 | 33 | 47 | 34 |
| staging | 45 | 0 | 45 | 47 | 47 |

Una aparición sin `:?` no demuestra que la variable sea opcional: `IMAGE` aparece sin operador en `IAXTI_IMAGE`, pero prod la exige en `image`. `REDIS_PASSWORD` también aparece dos veces. Las anclas distribuyen estas declaraciones a los servicios; no se cuentan cinco veces ni se cuentan comentarios. Los valores literales (`API_URL_INTERNAL`, `SERVICE`, etc.) no son interpolaciones.

Las doce variables exigidas en prod son `IMAGE`, `IAXTI_ENV`, `DATABASE_URL`, `REDIS_PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWKS_URL`, `API_URL_PUBLIC`, `APP_URL_PUBLIC`, `CORS_ORIGINS`, `FLOW_API_BASE` y `PUBLIC_API_URL`. Staging no exige ninguna de ellas mediante Compose; esto no significa que la aplicación pueda funcionar sin ellas.

## Las 33 variables opcionales de prod

«Silencioso» aquí significa que la rama examinada deshabilita una capacidad sin error de arranque ni aviso propio. Se distinguen los casos que sí dejan log, rechazan la operación o muestran un estado en la interfaz. No se confunde un valor por defecto intencional con una pérdida de capacidad.

| Variables | Si faltan o están vacías | Visibilidad y fuente en esta revisión |
| --- | --- | --- |
| `SENTRY_DSN` | No inicializa Sentry. | Desactivación sin aviso propio; [telemetry](../../../packages/telemetry/src/index.ts), `initObservability`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No inicializa el SDK/exportación OTLP. | Desactivación sin aviso propio; [telemetry](../../../packages/telemetry/src/index.ts). |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS` | Solo influyen si existe endpoint; protocolo vacío usa el tratamiento por defecto, headers vacías no aportan autenticación. | Dependiente del colector, no un fallo universal. Hay validación y diagnóstico de configuración/exportación en [telemetry](../../../packages/telemetry/src/index.ts), `revisarConfigOtel`. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Si falta cualquiera, cliente null; no traza ni consulta prompts versionados; se conserva fallback configurado. | Desactivación sin aviso propio en [langfuse.ts](../../../packages/modules/agents/application/langfuse.ts). |
| `LANGFUSE_BASE_URL` | Usa la base cloud declarada. | Default explícito en compose y `textoDeEntorno`; [langfuse.ts](../../../packages/modules/agents/application/langfuse.ts). |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Si falta cualquiera, transporte null; la campana puede seguir funcionando sin email. | Desactivación sin aviso propio en esa rama de [email.ts](../../../packages/modules/notifications/application/email.ts). |
| `SMTP_FROM` | Intenta usar SMTP_USER como dirección; si no es válida no construye transporte. | Error explícito en log; no se trata como pérdida silenciosa. [email.ts](../../../packages/modules/notifications/application/email.ts). |
| `SMTP_PORT` | Compose vacío llega como cadena vacía; `Number(SMTP_PORT ?? 587)` produce0, no587. | La evidencia solo acredita el valor entregado a Nodemailer; no se ensayó un servidor SMTP real. [email.ts](../../../packages/modules/notifications/application/email.ts). |
| `SUPABASE_SERVICE_ROLE_KEY` | No registra consumidores de broadcast para la bandeja. | Log «realtime de bandeja apagado»; degradación conocida por el operador, no error de arranque. [realtime.ts](../../../apps/workers/src/realtime.ts). |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_ADJUNTOS` | Si falta cualquiera, storage null; el ingreso conserva metadata original sin llave R2. | Worker registra la falta; bandeja muestra adjunto no guardado y no ofrece URL temporal. [storage.ts](../../../packages/core/src/storage.ts), [inbound.ts](../../../apps/workers/src/inbound.ts), sección C3 abajo. |
| `AUDIT_EXPORT_SECRET` | La exportación devuelve signature null. | No error de arranque; la ausencia es observable en el resultado, pero no queda firma verificable. [export.ts](../../../packages/modules/audit/src/export.ts). |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `GLM_API_KEY`, `OPENAI_API_KEY` | El proveedor no está disponible; al intentar usarlo se lanza error explicativo. GLM también habilita embeddings. | No es un rechazo del despliegue; sí hay guardas/errores al usarlo. [models.ts](../../../packages/modules/agents/application/models.ts), [embeddings.ts](../../../packages/modules/knowledge/application/embeddings.ts). |
| `GLM_API_BASE`, `OPENAI_API_BASE` | Utilizan las bases explícitas del compose y el respaldo del código. | Defaults declarados; [models.ts](../../../packages/modules/agents/application/models.ts). |
| `ZAVU_API_KEY`, `ZAVU_WEBHOOK_SECRET` | Las cuentas resuelven referencias a variables; sin credencial no pueden enviar y sin secreto no pueden acreditar firma entrante. | Fallo operativo/diagnóstico, no una conexión de canal funcional inferida del arranque. [webhooks.controller.ts](../../../apps/api/src/webhooks.controller.ts), [referencia-a-secreto.ts](../../../packages/core/src/referencia-a-secreto.ts), [readiness.ts](../../../apps/api/src/readiness.ts). |
| `ZAVU_API_BASE` | Usa la base Zavu declarada. | Default explícito; [zavu-base.ts](../../../packages/modules/whatsapp/application/zavu-base.ts). |
| `DB_POOL_MAX` | Usa6 conexiones; valores no numéricos/menores a1 también avisan. | Default validado; [client.ts](../../../packages/db/src/client.ts). |
| `AGENT_PRICES_JSON`, `BILLING_PRICES_JSON` | Conservan precios base si no hay override. | Defaults configurados; [config.ts](../../../packages/modules/agents/domain/config.ts), [pricing.ts](../../../packages/modules/billing/domain/pricing.ts). |
| `BILLING_USD_CLP`, `USD_CLP_RATE` | Primero valor válido de billing, después legado, después950. | Default validado; [pricing.ts](../../../packages/modules/billing/domain/pricing.ts). |
| `LOG_FORMAT` | Sin `json`, no activa el envoltorio de logs estructurados. | Selección explícita de formato; [telemetry](../../../packages/telemetry/src/index.ts). |

Los casos inequívocos de desactivación sin aviso propio encontrados son Sentry, OTLP sin endpoint, Langfuse sin sus llaves y SMTP sin host/usuario/contraseña. Son siete nombres de variable que desactivan cuatro capacidades; la firma de auditoría es otro caso de degradación sin error de arranque, pero se declara mediante `signature:null`. No se afirma que esas capacidades sean obligatorias: esa es la decisión C2 pendiente.

## Las doce adicionales sin obligatoriedad en staging

| Variables | Comportamiento al faltar |
| --- | --- |
| `IMAGE` | No queda una referencia de imagen válida; no es una capacidad opcional. |
| `DATABASE_URL` | `createPool` rechaza ausencia; algunas sondas/rutas también informan falta de DB. [client.ts](../../../packages/db/src/client.ts). |
| `REDIS_PASSWORD` | Se interpola vacía tanto en URL como en comando Redis; no hay garantía de autenticación no vacía. No se ensayó desplegar así. |
| `IAXTI_ENV` | Los lectores tienen defaults local/development; `entornoActual` avisa cadena vacía. No acredita aislamiento de producción. [entorno.ts](../../../packages/core/src/entorno.ts), [rls.ts](../../../packages/db/src/rls.ts). |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWKS_URL` | Falta configuración de login/verificación; readiness frontend marca degradación. Las restricciones del guard siguen aplicándose. [frontend-readiness.ts](../../../packages/telemetry/src/frontend-readiness.ts), [jwt.ts](../../../apps/api/src/auth/jwt.ts), [authz.guard.ts](../../../apps/api/src/authz/authz.guard.ts). |
| `API_URL_PUBLIC` | Frontend cae a localhost; no equivale a un endpoint público de staging correcto. [config.ts](../../../apps/web/lib/config.ts). |
| `APP_URL_PUBLIC` | Invitaciones usan respaldo app-staging. [equipo-usuarios.controller.ts](../../../apps/api/src/equipo-usuarios.controller.ts). |
| `CORS_ORIGINS` | Lista vacía refleja el origen en vez de aplicar lista cerrada. [main.ts](../../../apps/api/src/main.ts). |
| `FLOW_API_BASE`, `PUBLIC_API_URL` | Defaults sandbox de Flow y API staging, respectivamente; no deben interpretarse como producción. [flow-config.ts](../../../packages/modules/payments/domain/flow-config.ts), [links.ts](../../../packages/modules/payments/application/links.ts). |

## C3 ya tiene implementación en la base medida

No se duplica una propiedad `sinAlmacen`. [inbound.ts](../../../apps/workers/src/inbound.ts) conserva los adjuntos originales si R2 falta o la descarga falla; `receiveInbound` los persiste. [conversations.ts](../../../packages/modules/conversations/application/conversations.ts) proyecta solamente adjuntos con key y cuenta los restantes como `lostAttachments`. [chat.tsx](../../../apps/web/components/bandeja/chat.tsx) muestra el aviso para pedirlos de nuevo y no ofrece la URL efímera.

Existen pruebas de esos caminos en [adjuntos-que-se-ven.test.ts](../../../packages/modules/conversations/tests/adjuntos-que-se-ven.test.ts) y [inbound.e2e.test.ts](../../../apps/workers/tests/inbound.e2e.test.ts). Son evidencia de implementación preexistente; esta medición no ejecutó ni acreditó R2 real ni añadió código de producto.

## Verificación y pendientes

Se repitió el medidor y se contrastó el conteo con un análisis independiente de las interpolaciones. Se verificaron las referencias locales y la cobertura de los45 nombres en estas tablas. No se ejecuta un despliegue ni se cambian las variables obligatorias.

Refs #810; no cierre automático. C1 queda documentado; C2 requiere decidir/aplicar obligatoriedad y diferencias prod/staging. C4 aún requiere que la guarda distinga obligatoriedad conforme a esa política. La [guarda actual](../../../packages/core/tests/variables-del-despliegue.test.ts) comprueba presencia de claves y paridad, no obligatoriedad. El medidor es evidencia revisable de C1, no reemplazo de esa guarda. Los PR pendientes pueden agregar variables; repetir el medidor al integrarlos, conservando esta revisión como snapshot fechado.
