# Google Calendar (#57)

La rama implementa OAuth personal, free/busy, revocación y notificaciones.
Las pruebas locales usan el puerto HTTP y PostgreSQL/Redis con datos
sintéticos. No acreditan consentimiento, Secret Manager ni push reales:
para esa aceptación faltan una cuenta de prueba, el proyecto configurado y
un endpoint HTTPS accesible por Google. No se han desplegado recursos cloud.

En API, workers y agents se configuran mediante el gestor de secretos del
despliegue:

| Variable | Valor esperado |
|---|---|
| `GOOGLE_CLIENT_ID` | Cliente OAuth web de este despliegue |
| `GOOGLE_CLIENT_SECRET` | Secreto de ese cliente; nunca en Git |
| `GOOGLE_CALENDAR_REDIRECT_URI` | URL exacta del frontend terminada en `/agenda/google/callback`, registrada en Google |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | URL pública HTTPS de la API terminada en `/webhooks/google/calendar` |
| `GOOGLE_SECRET_PROJECT_ID` | Proyecto autorizado de Secret Manager |
| `GOOGLE_SECRET_LOCATION` | Ubicación de la réplica, por ejemplo la región aprobada `southamerica-west1` |

## Dónde viven los tokens

Se elige una custodia, nunca media (ADR-0028). Si están las variables de las
dos gana la local; si falta un pedazo de la elegida, Calendar queda apagado.

**v1 · en el VPS (lo que usamos hoy).** Dos variables:

| variable | qué es |
|---|---|
| `GOOGLE_SECRET_DIR` | carpeta en un **volumen que sobreviva al redespliegue**. En un directorio efímero los tokens se pierden en el próximo deploy y cada persona tiene que reconectar su calendario. |
| `GOOGLE_SECRET_KEY` | 32 bytes en base64: `openssl rand -base64 32`. Sin ella no se arranca; no hay modo sin cifrar. |

Si esa llave se pierde, los tokens guardados no se recuperan — se revoca y
cada persona vuelve a conectar. Si se rota, lo mismo: no hay recifrado
automático.

**Alternativa · Secret Manager.** `GOOGLE_SECRET_PROJECT_ID` y
`GOOGLE_SECRET_LOCATION`, y entonces sí hace falta todo lo de abajo.

Secret Manager usa Application Default Credentials. Configurar la identidad
del workload según el entorno; no copiar credenciales al repositorio ni al
navegador. Esta identidad necesita crear secretos y añadir, acceder y
destruir versiones y eliminar los secretos creados por esta integración. El Terraform previo solo concede `secretAccessor`:
ese permiso por sí solo no basta. Los recursos nuevos usan replicación
administrada por el usuario en la ubicación declarada; no hay ubicación
automática implícita.

## En la consola de Google

Activar Calendar API —y Secret Manager API **solo si** se eligió esa
custodia— en el proyecto correspondiente, y
registrar la pantalla de consentimiento y los usuarios de prueba según su
configuración. La aplicación solicita solo `openid` y
`https://www.googleapis.com/auth/calendar.events.freebusy`. El acceso se pide
desde Agenda, separado del login con Supabase. Si el consentimiento de prueba
vence, la aplicación exige reconectar y conserva el rastro del fallo.

Las migraciones se aplican con el rol de migraciones del proyecto, separado
del rol de aplicación. Las funciones que resuelven un webhook y revocan
grants entre tenants requieren un propietario con BYPASSRLS; no conceden ese
privilegio al rol de aplicación. Con un propietario sin ese privilegio
fallan en vez de invalidar solo parte de los tenants silenciosamente.

La validación externa pendiente debe hacerse por la aplicación: conectar
una cuenta de prueba, configurar una franja y un evento real en Google,
comprobar que la agenda excluye el evento y su buffer, cambiar el evento y
observar la notificación push, confirmar que la próxima consulta actualiza
los huecos, y revocar desde la aplicación. Verificar también los registros
de auditoría y la destrucción de versiones en Secret Manager. No usar curl
como sustituto de ese recorrido. Registrar la evidencia en el PR antes de
considerar completa la issue.

Al revocar, Google puede retirar otros permisos del mismo proyecto. La UI
lo advierte. Un timeout deja el estado pendiente y bloquea el acceso hasta
confirmar la revocación. La limpieza de versiones se reintenta en el worker;
no se deben borrar manualmente filas de custodia mientras existan secretos.

Referencias: [Secret Manager REST](https://docs.cloud.google.com/secret-manager/docs/reference/rest),
[OAuth incremental](https://developers.google.com/identity/protocols/oauth2/web-server),
[Calendar push](https://developers.google.com/workspace/calendar/api/guides/push).
