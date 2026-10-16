# #56 · Invitación de WhatsApp dentro de la puesta en marcha

Continuación técnica del criterio C4 de [#56](https://github.com/voxtilabs/IAxTi/issues/56).
No declara cerrada la issue: el primer mensaje y la sugerencia con proveedores
reales, el recorrido en staging menor de diez minutos y el video siguen pendientes.
Las pruebas usan personas, números y servicios HTTP sintéticos, identificados como
tales. No se enviaron mensajes ni se abrió una cuenta externa.

## Contrato y flujo implementado

`GET/POST /v1/onboarding/whatsapp` y `POST /v1/onboarding/whatsapp/retomar`
exigen sesión JWT humana, tenant verificado, módulo WhatsApp y permiso
`whatsapp.numbers.manage`. El cuerpo no acepta emisor, credenciales, roles,
proyecto ni tenant alternativos. Las respuestas privadas llevan `no-store`; el
enlace no entra en el cache SQL de idempotencia ni en una herramienta de IA.

La intención local se confirma antes del POST a Zavu. El proveedor no documenta
idempotencia ni metadata arbitraria: se manda únicamente `clientName` y
`connectionType: whatsapp_waba`. Tras la respuesta se confirma la relación
proyecto/invitationId/tenant antes de mostrar el enlace, guardado en Secret
Manager. Cada lectura humana del enlace deja auditoría, también si falla el
acceso. Una respuesta perdida queda `ambiguous`: no se repite el POST ni se busca
una invitación por nombre o correo. La UI permite revisar ese estado y explica
que necesita comprobación del operador; no ofrece una recreación insegura.

`POST /webhooks/zavu/invitations` verifica HMAC sobre el cuerpo crudo con el
secreto del proyecto y exige el proyecto configurado. Solo después resuelve la
relación persistida. Antes del commit responde 503 + `Retry-After`; no supone
que Zavu reintenta un 404. El evento mínimo se persiste con auditoría y se encola
en BullMQ; un deadline de 800 ms responde 503 si la persistencia/cola se detiene.
Los eventos pendientes sobreviven a una caída de Redis y al apagado del módulo.

El worker consulta el estado canónico de la invitación y su emisor. Comprueba
canal WhatsApp e igualdad de `connectedAccount.id` con
`sender.whatsapp.phoneNumberId`. La cuenta y reserva del emisor nacen
`connecting`. Después configura webhook inactivo, rota por
`POST /v1/senders/{id}/webhook/secret`, custodia el secreto con intención durable,
lo vuelve a leer, habilita el webhook y verifica su URL, eventos, canal y cuenta
Meta. Solo entonces confirma estado `active`, referencia, auditoría y outbox en
la misma transacción local. No se inventa una transacción distribuida: una
respuesta remota perdida o rollback local requiere recuperación explícita.

El intento de rotación incierto queda `recovery_required`, sin rerotar ante cada
callback. «Reintentar conexión segura» autoriza un nuevo intento identificado.
Una entrega entre enable remoto y COMMIT active responde 503 reintentable; no
se acusa firma inválida ni se encola antes de confirmar la cuenta. El acceso
nuevo a SM en el webhook entrante comparte un deadline de 800 ms, con abort.
Las cuentas desconectadas, los tenants bloqueados y módulos apagados no se
reactivan por eventos tardíos. El vencimiento local retira el enlace pero consulta el estado canónico antes
de declarar expirado el intento: un completed tardío todavía puede conectarlo.
El reenvío desde el dashboard puede reabrir una invitación cancelled con otra
URL. Se reemplaza la custodia y se retira la referencia anterior. Si ya existe
un intento posterior, se conserva ese intento y se muestra un conflicto; no
se reactiva silenciosamente el anterior.

El barrido `identity.partner.maintain` recupera eventos durables, reconoce
interrupciones sin repetir create/rotate y retira enlaces pendientes vencidos.
Limpia intenciones huérfanas de custodia después de 15 minutos incluso con
WhatsApp apagado. Tanto el guardado como el borrado bloquean la fila de intención;
si la limpieza llegó primero, no se escribe un secreto sin intención durable.
Cada snapshot de URL tiene una generación: una lectura antigua que termina
después de un reenvío no puede restaurar el enlace inválido. Las referencias
activas no son candidatas a limpieza. No se guardan tokens,
enlaces ni payload de secretos en SQL, outbox, auditoría o trabajos Redis.

## Preparación del operador

Se reutiliza el almacén de #57 (`GOOGLE_SECRET_PROJECT_ID`,
`GOOGLE_SECRET_LOCATION`, ADC y permisos de Secret Manager), no otro servicio de
custodia. La API y los workers necesitan el mismo proyecto configurado.

- `ZAVU_PARTNER_PROJECT_ID`: id exacto de `/v1/me`.
- `ZAVU_PARTNER_CREDENTIAL_REF`: nombre de variable de entorno que contiene la
  API key; por defecto `ZAVU_API_KEY`. Nunca se acepta desde el navegador.
- `ZAVU_PARTNER_API_URL`: origen/base HTTPS público de la API, sin query ni
  credenciales. Para interoperar con #74 debe coincidir con `API_URL_PUBLIC`.
- `ZAVU_PARTNER_WEBHOOK_SECRET`: secreto de firma del webhook del proyecto,
  configurado por el operador, no el secreto de cada emisor.
- Configurar en Zavu el webhook de proyecto hacia
  `/webhooks/zavu/invitations`, con evento `invitation.status_changed`.
  Ese webhook no recibe mensajes; el worker configura el webhook del emisor.
- Conservar las guardas existentes `IAXTI_ENV` / `ZAVU_ENVIOS_REALES`. No se
  habilitan envíos reales con este cambio. Los entornos con prueba real requieren
  la preparación y autorización ya previstas en el repositorio.

Ausencia de configuración devuelve un error rastreable, no un alta simulada.
Si create quedó ambiguo, el operador debe contrastar el proyecto en el proveedor
antes de cualquier corrección manual; esta implementación no ofrece una API
para atribuir por conjetura un id remoto al tenant. La custodia existente de
cuentas manuales por referencia ENV sigue siendo compatible. Los canales
secundarios de #74 heredan la referencia de su receptor compartido sin rotarlo.

Fuentes oficiales consultadas:
[invitaciones](https://docs.zavu.dev/guides/partner-invitations-api),
[webhook del proyecto](https://docs.zavu.dev/api-reference/configure-project-webhook),
[OpenAPI Zavu](https://docs.zavu.dev/openapi.json).
Las dependencias de código son #57 (`dbb32f2`) y #74 (`00044cb`), integradas
mediante merges explícitos sobre la implementación previa de #56 (`7d54fca`).

## Evidencia reproducible

- `packages/modules/whatsapp/tests/partner.test.ts`: PostgreSQL con rol propio
  sin BYPASSRLS y receptores HTTP locales; creación concurrente, HMAC/proyecto,
  respuesta perdida, referencias cruzadas, cuenta Meta sustituida, expiración,
  rollback de auditoría, custodia/rotación fallida y carrera de limpieza.
- `apps/api/tests/partner-invitations.test.ts`: Nest HTTP, permisos, cuerpo
  cerrado, actor, módulo off, rawbody, errores sin secretos, deadline y OpenAPI.
  Sustituye los servicios de negocio; no sustituye las pruebas RLS anteriores.
- `apps/web/tests/whatsapp-invitation.test.tsx`: carga, error con rastro, doble
  clic, respuesta tardía de otra sesión/tenant, ambigüedad y recuperación.
- `apps/web/e2e/run-partner.mjs`: JWT con JWKS local, API y RLS reales, cola y
  worker BullMQ, módulo de conexión real y SDK Secret Manager contra HTTP
  sintético. No intercepta endpoints de aplicación en Playwright. Solo cambia
  los puertos del proveedor y ADC. Navegador a 360 px en día/noche, llegada con
  Tab y activación con Enter, recarga sin duplicar invitación, callback firmado,
  recuperación de rotación y confirmación de la puesta en marcha.

```sh
pnpm install --frozen-lockfile
pnpm build
TODO=1 pnpm antes-de-empujar
pnpm --filter @iaxti/web e2e:partner
```

Requieren `DATABASE_URL` de una base local `iaxti_test_*`, `APP_DATABASE_URL`
para la misma base con rol `iaxti_app` sin bypass y `REDIS_URL` local con DB1–15.
El arnés crea la base y el rol de pruebas si faltan, nunca altera un rol ya
existente y comprueba sus permisos antes de arrancar la API. Usa puertos
4071–4073; CI elige una base propia y Redis10;
guarda solo JWT sintéticos en un archivo ignorado y lo elimina al terminar.
El comando E2E exige un build coherente de Next; no demuestra login de Google,
permisos comerciales de Zavu ni entrega real de Meta.

## SPEC §34 / controles del delta

1. Puertos públicos; sin SQL ajeno desde WhatsApp ni ciclos nuevos.
2. Módulo, permisos, JWT, validación y OpenAPI; callback con HMAC.
3. Auditoría/outbox con mutaciones locales en la misma transacción.
4. Tres tablas con tenant, RLS forzado e índices por tenant.
5. Migración 0009 aditiva; compatible con referencias ENV anteriores.
6. Regresiones de DB, HTTP, DOM, navegador y guardas del repositorio.
7. Operaciones personales excluidas justificadamente del catálogo IA.
8. No envíos, cambios de consentimiento, ventana ni horario.
9. No cambia modelos, precios, prompts ni política de proveedores.
10. Componentes y tokens Pulso, sin tema local.
11. Día/noche, 360 px, teclado y estados rastreables.
12. Solo secretos por referencia, sin credenciales reales en evidencia.
13. Inventario, baseline técnico y runbook actualizados; sin declaración legal.
14. Referencia #56, sin cierre automático ni despliegue.

`/module-check`, `/security-review` y `/ui-check` se aplicaron al delta:
contratos públicos, RLS/permiso, custodia por referencia, auditoría atómica,
HMAC y límites de tiempo; estados, teclado y tamaños del panel nuevo. No se
modificó la política comercial ni se certificó cumplimiento legal.

## Resultados del snapshot final

- Preflight completo `TODO=1 pnpm antes-de-empujar`: 3.108 pruebas aprobadas y
  14 omisiones existentes, en 29 paquetes; tipos 56/56 y builds 31/31. La
  repetición final reutiliza la caché válida de Turbo para las tareas intactas.
  Guardas de esquema, límites de módulos, catálogo y migración virgen también
  aprobadas. Hay 106 migraciones en esta combinación de dependencias.
- Cobertura dirigida: 19 pruebas PostgreSQL/HTTP de negocio, 9 pruebas HTTP de
  API y 6 DOM. El navegador aprobó 3/3 recorridos en 26,5 s: día, noche y fallo
  de rotación con recuperación explícita. Estos recuentos dirigidos están
  incluidos en el preflight cuando corresponden; no se suman dos veces.
- Un revisor distinto del implementador repitió 19 SQL + 9 HTTP en otra base y
  Redis aislado. Otro revisor leyó las regresiones de carreras/expiración y el
  diff, sin atribuirse una ejecución. Ambos reutilizaron el contexto de este
  equipo; no se presentan como revisores sin contexto. Sin hallazgos abiertos
  en el alcance técnico revisado.
- La crítica detectó casos de intención retirada durante
  custodia, caducidad local frente a completed tardío, orden de locks, URL nueva
  tras reenvío, snapshot obsoleto y deadlines. Sus contraejemplos están ahora
  cubiertos. Se conservaron los logs de las corridas fallidas iniciales. Las
  guardas también detectaron el nuevo trabajo repetible y la
  exclusión faltante del callback en el catálogo, corregidos sin bajar umbrales.
- La medición inicial encontró el texto del botón de recuperación cortado a
  46 px; el ajuste local final mide 69,1875 px y contiene el texto completo.
  Las siete mediciones finales cumplen el encaje y foco visible, usando Tab
  real; los botones miden al menos 46 px. [Medidas](medidas.json).
- Las cuatro advertencias de hooks anteriores de lint permanecen. El arnés
  observó una advertencia de deprecación de `pg` sobre consultas simultáneas
  en un cliente; no impidió el recorrido y no se interpreta como una prueba
  de compatibilidad con una futura versión mayor.

Las capturas son del panel de conexión a viewport de 360 px; no acreditan una
captura de pantalla completa ni el panel del proveedor real.

| Recorrido | Inicio | Enlace custodiado | Activo |
| --- | --- | --- | --- |
| Día | [Inicio](partner-dia-360-inicio.png) | [Enlace](partner-dia-360-enlace.png) | [Activo](partner-dia-360-activo.png) |
| Noche | [Inicio](partner-noche-360-inicio.png) | [Enlace](partner-noche-360-enlace.png) | [Activo](partner-noche-360-activo.png) |
| Recuperación | [Inicio](partner-recuperacion-360-inicio.png) | [Enlace](partner-recuperacion-360-enlace.png) | [Activo](partner-recuperacion-360-activo.png) |

[Fallo de custodia y acción de recuperación](partner-recuperacion-360-pendiente.png).
[Resumen verificable](verificacion.json) contiene conteos, huellas de los logs y
límites. C4 queda implementado y probado con contratos HTTP sintéticos; la
aceptación externa de #56 continúa pendiente.


## Separación del E2E general y CI

`playwright.config.ts` excluye únicamente `partner-invitations.spec.ts`, cuya
fixture JWT/worker es distinta. No se omite la prueba: CI ejecuta el script
`e2e:partner` en un paso obligatorio posterior al E2E general, contra
`iaxti_test_partner_e2e` y Redis10. No depende de que los tests de Turbo hayan
creado roles/base, ni usa puertos de Redis particulares de una máquina.

La comprobación con el arnés general `e2e --list`, sin `.partner-auth.json`,
recogió 99 pruebas de 20 archivos. Es validación de colección, no ejecución de
esas 99 pruebas. La ejecución separada `e2e:partner` creó una base nueva y
aprobó 3/3 recorridos en 26,7 s. Lint (cero errores, cuatro avisos existentes),
tipos de web y sintaxis/orden del workflow aprobados. El preflight completo
anterior corresponde al código de producto sin cambios; este seguimiento
solo corrige configuración/orquestación de las pruebas y documenta su evidencia.
