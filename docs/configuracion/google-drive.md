# Google Drive personal (#64)

El consentimiento usa `drive.file`, limitado a archivos seleccionados o creados por IAxTi. No solicita `drive.readonly` ni lista todo el Drive. Calendar y Drive comparten el grant personal `(tenant, user)` de ADR-0027 y una referencia de Secret Manager. Añadir un servicio solo conserva los anteriores si Google confirma todos sus scopes efectivos; un canje parcial no sustituye el refresh token vigente.

## Configuración del despliegue

Además de la custodia Google de ADR-0027, configurar en servidor `GOOGLE_DRIVE_REDIRECT_URI` con la ruta pública `/integraciones/drive/callback`, `GOOGLE_PICKER_API_KEY` y `GOOGLE_PICKER_APP_ID` (número de proyecto). Se reutilizan `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SECRET_PROJECT_ID` y `GOOGLE_SECRET_LOCATION`. Habilitar Drive API y Google Picker API; registrar el redirect exacto y los orígenes web autorizados en el cliente OAuth. Restringir la API key pública a Picker y a los orígenes HTTPS del despliegue. No se guardan valores de configuración en este documento.

El cliente ID, API key de Picker y número de proyecto son configuración pública. El access/refresh token compuesto del servidor **nunca** sale de Secret Manager. Picker obtiene en memoria un token distinto mediante GIS `include_granted_scopes:false`; el navegador verifica que su único scope sea `drive.file`. El token no se guarda en storage, logs ni argumentos de herramientas. Cerrar el selector o cambiar usuario/tenant destruye su instancia y descarta respuestas tardías. Elegir una cuenta en Google no acredita identidad en IAxTi: el servidor vuelve a consultar cada fileId con el grant custodiado de la persona autenticada.

La pantalla `/ajustes/drive` permite scripts oficiales de `accounts.google.com` y `apis.google.com`, y frames de `accounts.google.com`/`docs.google.com`. El callback tiene `Referrer-Policy:no-referrer`, `Cache-Control:no-store` y elimina code/state del historial antes de canjear. Las CSP del proxy deben conservar esos orígenes exactos; no abrir comodines. La prueba local sustituye estos servicios, no demuestra configuración de una cuenta Google real.

## Recorrido y alcance

1. Una sesión JWT humana con `integrations.connect` autoriza Drive mediante state, nonce y PKCE. API keys y fallback de desarrollo no acceden a esta integración personal.
2. La persona elige un archivo en Picker. Backend verifica acceso y guarda solo metadata, asociada a su grant/cuenta/tenant/usuario. La lectura IA empieza apagada.
3. En una ficha o conversación autorizada, adjuntar publica una referencia para el equipo. No envía mensajes, cambia ACL de Google ni comparte consentimiento IA. La referencia conserva la metadata que se adjuntó y se incluye en la exportación del negocio.
4. `drive.search` y `drive.attach` son herramientas del Agente General que llaman a esas mismas rutas con la sesión humana. `drive.attach` siempre presenta confirmación antes de ejecutar; no pertenece al ejecutor autónomo ni al de API keys. Búsqueda paginada: cinco archivos, cuatro segundos de proveedor, dos MiB por documento y 4.800 caracteres totales. `truncated` y `nextCursor` hacen visible el corte.
5. La lectura IA requiere permiso explícito por documento, `knowledge.read`, capability `knowledge` y acceso vigente al contacto/conversación del contexto. Solo procesa texto, Markdown, CSV y exportación de Docs/Sheets/Slides en memoria; no crea sources/chunks globales. PDF e imágenes siguen adjuntables, pero se muestran como no consultables por IA. No se envían a un extractor externo.
6. Activar copias por contacto guarda únicamente nuevos adjuntos recibidos a partir de esa activación. El outbox genera intención durable aun si la configuración remota queda temporalmente ausente. El worker real `integrations.drive.sync` selecciona únicamente tenants con pendientes elegibles y reintenta con backoff. IDs preasignados de carpeta/archivo se confirman antes de crear nada en Drive. Reintentar después de un efecto remoto incierto valida ID, marca, carpeta, tamaño y checksum; no duplica el archivo.

## Revocación y supresión

Revocar bloquea inmediatamente todos los servicios de la cuenta Google para este cliente OAuth, incluso en otros tenants. La limpieza de cada consumidor relee el grant bajo lock y no invalida una reconexión nueva por un evento viejo. Reconectar Drive no reactiva silenciosamente lectura IA ni copias automáticas.

La supresión de un contacto persiste `anonymized_at` y `contact.anonymized` en la misma transacción. El puerto CRM y un lock SHARE impiden que una lectura/copia nueva se adelante a la supresión. Antes de procesar el evento ya se deniegan referencias y activación. El consumidor elimina referencias y configuración local; los pendientes desaparecen al borrar sus mensajes. Las copias ya guardadas en el Drive personal las administra la persona en Google: desactivar o suprimir en IAxTi **no las borra de Google**, y el opt-in lo explica.

Orden de coordinación: cuenta Google → contacto → carpeta → entrega. La supresión adquiere contacto antes de borrar mensajes; una copia que ya comenzó termina antes de que esa supresión pueda confirmar. No hay locks de sesión ni dependencia de dos conexiones simultáneas en el runner.

## Fuentes oficiales consultadas

- [Scopes mínimos Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
- [Picker web](https://developers.google.com/workspace/drive/picker/guides/web-picker), [dispose y ciclo de vida](https://developers.google.com/workspace/drive/picker/reference/picker.picker).
- [GIS TokenClientConfig, include_granted_scopes y TokenResponse](https://developers.google.com/identity/oauth2/web/reference/js-reference).
- [OAuth incremental y revocación](https://developers.google.com/identity/protocols/oauth2/web-server).
- [Descargas/exportación](https://developers.google.com/workspace/drive/api/guides/manage-downloads).
- [Subidas resumibles e IDs preasignados](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [generateIds](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds).

## Límite de esta evidencia

PostgreSQL, RLS, API, worker, SDK e interfaz se verifican localmente. Los transportes Google, Secret Manager y Picker de las pruebas están sustituidos de forma explícita. Falta aceptación con cliente OAuth/Picker habilitado, identidad Google real y permisos GCP del despliegue. No se envían datos externos reales durante estas pruebas ni se acredita despliegue en staging.
