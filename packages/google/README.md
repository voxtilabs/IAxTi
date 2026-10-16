# @iaxti/google

Infraestructura de Google para #57: OAuth, Secret Manager y Calendar. No contiene SQL,
contexto de tenant, permisos, auditoría, colas ni decisiones de disponibilidad. Esos
controles pertenecen a los módulos consumidores.

Se fija `google-auth-library` **11.3.0** (publicada el 2026-10-12), compatible con Node 22.
El SDK oficial genera la autorización, verifica la firma/claims del ID token y obtiene
credenciales ADC. Los endpoints de datos usan `fetch` de Node con timeout, cancelación y
redirecciones prohibidas. No hay una operación pública para consultar URLs arbitrarias.
No se necesita `googleapis`.

## Contrato

`src/index.ts` exporta las interfaces de los tres puertos y sus configuraciones:

- `createGoogleOAuth({ clientId, clientSecret, redirectUri }, options)`:
  `authorizationUrl({ state, challenge, nonce, scopes, loginHint? })`,
  `exchange({ code, verifier, signal? })`, `refresh(refreshToken, options?)`,
  `revoke(token, options?)`, `verifyIdToken({ idToken, nonce, signal? })`.
- `createGoogleSecretStore({ projectId, location }, options)`:
  `put(secretId, payload, options?)`, `addVersion(secretId, payload, options?)`,
  `access(versionRef, options?)`, `destroy(versionRef, options?)`, `deleteSecret(secretId, options?)`.
  `put` y `addVersion` devuelven la referencia completa de una versión numérica.
- `createGoogleCalendarClient(options)`:
  `freebusy({ accessToken, calendarIds, timeMin, timeMax, timeZone?, signal? })`,
  `watch({ accessToken, calendarId, channelId, channelToken, address, expiration, signal? })`,
  `stop({ accessToken, channelId, resourceId, signal? })`.

`options.fetch` permite interceptar HTTP en pruebas; `timeoutMs` vale 10 segundos por
etapa (máximo 120 segundos). Secret Manager además permite inyectar `accessToken` para
pruebas. La espera de ADC está acotada aunque el descubrimiento interno del SDK no se
pueda cancelar; un resultado tardío no inicia una solicitud a Secret Manager.

Los errores públicos son `GoogleIntegrationError` con `code` estable y `status`
opcional. No conservan mensajes, cuerpos, requests ni `cause` del proveedor. El caller
no debe registrar respuestas exitosas que contienen tokens o payloads secretos.

## Invariantes y responsabilidades del caller

OAuth solicita acceso offline e incremental con PKCE S256. El navegador genera el
verifier; el consumidor vincula state/challenge/nonce al actor y tenant, controla TTL y
consumo único, y llama a `verifyIdToken` antes de confiar en `sub`. Una respuesta de
refresh puede omitir `refreshToken` e `idToken`; el caller conserva el refresh token
anterior. `scope: []` cuando Google lo omite no acredita ningún permiso nuevo.

`GOOGLE_CALENDAR_SCOPE` es `https://www.googleapis.com/auth/calendar.events.freebusy`.
El caller pide también `openid` para verificar el sujeto. Un error `invalid_grant`
se clasifica como `GOOGLE_INVALID_GRANT`; no se convierte en disponibilidad libre.
`invalid_token` se clasifica como `GOOGLE_INVALID_TOKEN`, no como éxito: el caller
debe reconciliar los demás tokens conocidos antes de cerrar la revocación.
La revocación de Google afecta a los permisos concedidos a la aplicación: el módulo
consumidor debe explicar su alcance y reconciliar todos los grants afectados.

Secret Manager exige ubicación explícita (`userManaged`), por ejemplo
`southamerica-west1`, y referencias vinculadas al proyecto configurado. Nunca se usa
`latest`. CRC32C se envía al guardar y se comprueba al leer; el puerto admite texto
UTF-8 de hasta 64 KiB. ADC debe tener `secretmanager.secrets.create`,
`secretmanager.versions.add`, `secretmanager.versions.access`,
`secretmanager.versions.get`, `secretmanager.versions.destroy` y `secretmanager.secrets.delete` sobre los recursos
necesarios. Un rol solo de lectura no basta. No se aplican recursos cloud desde aquí.

Crear secreto y añadir versión son dos operaciones: `put` no es una transacción. Un
fallo tras crear puede dejar un secreto vacío, y repetir el mismo ID devuelve conflicto.
El caller debe conservar una intención durable para recuperación y gestionar limpieza
con referencias exactas; no debe borrar un secreto completo que pudo ser reconectado.
`destroy` admite una versión ya destruida o ausente, sin ocultar fallos de autorización.
`deleteSecret` es solo para limpiar la intención durable de un secreto nuevo con UUID
que nunca se confirmó: el caller verifica esa precondición. Su 404 es idempotente.
Nunca debe aplicarse a un grant activo ni a un ID elegido por el usuario.

Calendar valida cada calendario incluso con HTTP 200; un calendario ausente, errores
parciales o intervalos inválidos fallan. Los intervalos mantienen su zona RFC3339. El
caller combina esos intervalos con citas locales y aplica la zona horaria del negocio.
`watch` solo crea el canal: recepción, comprobación del token/recurso, deduplicación,
renovación, permisos y auditoría corresponden al consumidor.

## Verificación local

```sh
pnpm --filter @iaxti/google test
pnpm --filter @iaxti/google typecheck
pnpm --filter @iaxti/google build
pnpm exec eslint packages/google/src packages/google/tests
```

Las pruebas interceptan `fetch` sin sustituir el código del paquete. La comprobación
JWT utiliza claves RSA y la verificación real del SDK. No acreditan consentimiento,
permisos IAM, entrega push ni revocación frente a una cuenta real.

## Fuentes oficiales consultadas (2026-10-16)

- [SDK oficial y publicación fijada](https://www.npmjs.com/package/google-auth-library/v/11.3.0)
- [OAuth para servidor web](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Calendar freebusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Calendar events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch)
- [Calendar push](https://developers.google.com/workspace/calendar/api/guides/push)
- [Secret Manager create](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create)
- [Secret Manager addVersion](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/addVersion)
- [Secret Manager access](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/access)
- [Secret Manager destroy](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/destroy)
- [Secret Manager delete](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/delete)
- [Replicación explícita](https://docs.cloud.google.com/secret-manager/docs/choosing-replication)

## Gmail y Pub/Sub (#65)

`createGoogleGmailClient` ofrece profile, threads, watch y stop sobre endpoints
fijos. threads consulta correo exacto, proyecta solo headers/snippet/fecha, acota
páginas, tamaño y tiempo, y devuelve truncated cuando alcanza el límite. Nunca
pide cuerpos, raw ni adjuntos. `createGooglePubSubVerifier` verifica el ID token
OIDC con google-auth-library, audiencia, issuer, vida máxima de una hora, cuenta
de servicio exacta y email verificado. La caché de certificados permite rotación
y limita refrescos por kid desconocido a uno por minuto. El caller aún debe
validar la suscripción y el envelope, autorizar y auditar cada lectura.

Fuentes: [Gmail threads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get),
[notificaciones](https://developers.google.com/workspace/gmail/api/guides/push),
[push autenticado](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
