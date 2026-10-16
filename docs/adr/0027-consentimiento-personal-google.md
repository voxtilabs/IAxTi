# 0027 · Consentimiento personal de Google (#57)

Estado: implementado en esta rama; pendiente de validación con cuenta real y configuración de despliegue.

Calendar pertenece al plan Base. Drive y Gmail pertenecen a integrations,
que requiere Crece. Por eso Calendar no puede depender de que integrations
esté habilitado para pedir o revocar el consentimiento de una persona.

`identity` conserva la identidad del grant (tenant, usuario, cliente OAuth,
subject verificado, scopes efectivos y referencia inmutable al secreto), sus
intentos de un uso y los eventos `integration.connected`/`integration.revoked`.
Calendar conserva la conexión, los leases push y la caché de ocupación. Los
tokens completos viven únicamente en Secret Manager. `@iaxti/google` reúne
OAuth, verificación del ID token con el SDK oficial, ADC, Secret Manager y
los transportes HTTP; no conoce tablas, permisos ni módulos de negocio.

Audit depende de identity; identity recibe un puerto obligatorio de auditoría
del compositor para evitar una dependencia circular. Los cambios de grant y
sus eventos se confirman junto con la auditoría en PostgreSQL. La destrucción
de versiones reemplazadas queda en una cola durable de referencias. Una
revocación de Google no es una transacción distribuida con PostgreSQL: ante
un resultado remoto incierto el estado sigue `revoking` y el acceso queda
bloqueado. La intención `revoking` se confirma antes de llamar a Google;
un fallo de auditoría o COMMIT después del revoke no puede restaurar `active`.
La persona puede reintentar desde la aplicación.

Crear un secreto también requiere una intención durable previa. El callback
bloquea esa fila y exige que exista antes de llamar al almacén; la limpieza
usa SKIP LOCKED. La antigüedad habilita recoger intentos abandonados, pero
no permite borrar una creación en curso. Las versiones desconocidas por
un timeout al añadir una versión se eliminan al recoger el recurso completo
cuando se reemplaza o revoca el grant; no se afirma descubrirlas antes.

Google revoca el consentimiento para la cuenta y el proyecto, no solo para
Calendar. Esta implementación usa un cliente OAuth configurado por despliegue
y bloquea/revoca todos los grants conocidos para ese cliente y subject,
incluidos los de otros tenants. Nunca devuelve sus identidades por la API.
No se deben configurar otros clientes OAuth del mismo proyecto por fuera
de esta custodia: requerirían coordinar también su revocación. Los cerrojos
de cuenta serializan consentimiento, refresh y revocación.

Se solicitan `openid` y `calendar.events.freebusy` al conectar, nunca durante
el login de IAxTi. El segundo scope sirve tanto para free/busy como para
`events.watch`, sin acceder a títulos ni asistentes. PKCE, state, nonce y
usuario/tenant vinculan el callback con su inicio. PostgreSQL guarda hashes
de state y nonce y el challenge; el intento se consume antes del intercambio.

Las notificaciones de Calendar tienen body vacío y autentican el canal con
`X-Goog-Channel-Token`. Se guarda su SHA-256 y se comprueban también canal,
recurso y vencimiento. Se encola el trabajo, y un contador monotónico impide
aplicar duplicados o mensajes antiguos. `sync` inicial puede llegar antes de
la respuesta a watch; no contiene cambios y crear el lease invalida la caché.
Los avisos invalidan la caché; la siguiente consulta obtiene free/busy real.
La caché dura como máximo 60 segundos y solo se reutiliza con un lease vivo.
El worker renueva leases; no sondea eventos ni free/busy periódicamente.

Los buffers se comparan en instantes y la ventana consultada incluye el
respiro a ambos lados del día. PostgreSQL resuelve los límites en la zona
del negocio. Sin conexión se usa la agenda local; con una conexión fallida
se informa el error y no se inventan horas libres. La lectura, sus límites y
el cruce con la disponibilidad comparten el cerrojo de la cuenta con las
escrituras de horario, de modo que un cambio de buffer invalida el caché
después de la lectura en curso. El copiloto reutiliza su PoolClient y su
transacción; en ese camino la auditoría se confirma con el trabajo del
invocador, sin abrir una transacción que espere por su propio cerrojo.

`calendar.manage_availability` permite editar el horario propio;
`calendar.manage_team` agrega la disponibilidad del equipo para supervisión.
Las lecturas de agenda se limitan al dueño salvo ese permiso. La conexión
personal exige JWT humano aun en desarrollo, sin API keys ni modo soporte.

Fuentes: [OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server),
[push de Calendar](https://developers.google.com/workspace/calendar/api/guides/push),
[freebusy.query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query),
[events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch).
