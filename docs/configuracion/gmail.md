# Gmail personal de solo lectura (#65)

La ficha del contacto muestra hilos de la cuenta Google de la persona que inició
sesión. Busca únicamente el correo exacto guardado en CRM, verifica el dueño del
contacto o `crm.read_all`, y devuelve asunto, extracto y fecha. No admite consultas
Gmail libres, no descarga cuerpos ni adjuntos, no envía correo y no indexa correo
como conocimiento. Integrations requiere plan Crece; el rol USER puede conectar y
leer su propia cuenta. Una API key no sustituye el JWT humano.

## Configuración del despliegue

Se reutilizan `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_SECRET_PROJECT_ID` y `GOOGLE_SECRET_LOCATION` del
[consentimiento Google](google-calendar.md). Los tokens permanecen en Secret Manager
con ADC y replicación explícita; PostgreSQL guarda referencias, scopes y estado.

| Variable | Contenido |
|---|---|
| `GOOGLE_GMAIL_REDIRECT_URI` | URL exacta del frontend `/integraciones/gmail/callback` registrada en el cliente OAuth |
| `GOOGLE_GMAIL_TOPIC` | `projects/PROYECTO/topics/TEMA`, del mismo proyecto usado para Gmail watch |
| `GOOGLE_GMAIL_SUBSCRIPTION` | `projects/PROYECTO/subscriptions/SUSCRIPCION`, coincidencia exacta con el envelope recibido |
| `GOOGLE_GMAIL_PUSH_AUDIENCE` | Audience OIDC configurada en la suscripción; normalmente la URL HTTPS pública `/webhooks/google/gmail` |
| `GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT` | Email exacto del service account usado por Pub/Sub al entregar push |

Activar Gmail API y Pub/Sub. Dar permiso de publicación sobre el tema a
`gmail-api-push@system.gserviceaccount.com`. Configurar push autenticado y los
permisos de creación de tokens para el agente de Pub/Sub según la documentación
oficial. No basta con crear el tema ni con que el endpoint sea público. El tema de
`watch` debe pertenecer al proyecto del cliente OAuth. La aplicación pide `openid`
y `gmail.readonly` de forma incremental. Este scope es restringido: el despliegue
público requiere completar los requisitos de verificación de Google aplicables.
No se han aplicado recursos cloud ni realizado consentimiento con una cuenta real.

## Lectura, notificaciones y conservación

`gmail.get_threads` usa la misma ruta autenticada que la ficha CRM, con `contactId`.
La consulta limita tres páginas de candidatos, cien hilos y veinte segundos. Si
alcanza el límite, muestra que puede haber más; ordena los hilos recuperados por la
fecha del mensaje que incluye al contacto. Direcciones que aparecen solo en el
nombre visible no cuentan como coincidencia. El DTO solo contiene resúmenes.

Pub/Sub se verifica con el SDK oficial: firma RS256, issuer, audience, expiración,
email exacto y `email_verified`. El receptor valida la suscripción, confirma solo
cuando la cola durable aceptó el evento y guarda en ella hash del buzón, historyId
e ID de mensaje. Los IDs históricos se comparan numéricamente sin convertirlos a
Number: duplicados y mensajes atrasados no hacen retroceder la versión. El push
invalida caché, no obtiene correo ni crea documentos. La renovación del watch cada
quince minutos consulta profile/watch cuando corresponde; nunca sondea hilos.

La caché está separada por tenant, usuario/conexión y contacto, ligada a la
generación del grant y al historial del buzón. Se sirve por hasta sesenta segundos,
solo con watch vigente; «Consultar de nuevo» vuelve a Google. La limpieza física
periódica retira entradas vencidas incluso si el tenant está suspendido o
integrations se apagó. La supresión de un contacto niega nuevas lecturas antes del
outbox y su evento elimina la caché tempranamente. La revocación bloquea acceso y
retira la conexión; los eventos antiguos no borran una reconexión posterior.

El Agente General entrega el resumen al usuario y al modelo elegido para responder
su solicitud. Al usar Gmail o Drive personal, omite textos, argumentos y resultados
en agent_executions, trazas Langfuse y respuestas persistidas de idempotencia;
conserva métricas y pasos. El marcador continúa en las preguntas siguientes del
hilo en memoria, también tras error parcial. Cambiar usuario o negocio descarta ese
hilo. Un reintento de una respuesta personal con la misma llave devuelve un error
explícito sin volver a ejecutar la acción ni recuperar una copia persistida.

## Aceptación externa pendiente

Las pruebas interceptan Google y Secret Manager; la firma OIDC usa claves de prueba
y el verificador oficial. PostgreSQL/RLS, Nest/JWT y el navegador se prueban localmente.
Esto no acredita credenciales IAM, permiso OAuth, entrega Pub/Sub, revocación ni
contenido reales. Antes de cerrar #65: conectar desde la aplicación con una cuenta
de ensayo, abrir un contacto con correo conocido y comprobar asunto/extracto/orden,
recibir un correo y comprobar invalidación push, retirar el permiso y comprobar que
las lecturas quedan bloqueadas y los secretos se destruyen. Revisar auditoría sin
contenido personal. Registrar evidencia sin guardar tokens ni correos privados.

Fuentes oficiales: [threads.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list),
[threads.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get),
[scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[push Gmail](https://developers.google.com/workspace/gmail/api/guides/push),
[OIDC Pub/Sub](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
