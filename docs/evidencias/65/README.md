# Gmail en la ficha: evidencia local #65

Recorrido `apps/web/e2e/gmail.spec.ts`: dos pruebas Chromium con viewport de
360 × 780 CSS px, modos día y noche. Son doce capturas **de locators** (panel o
modal), no pantallas completas. El DPR del emulador explica el tamaño del PNG.

Se atraviesan shell, sesión JWT, rol USER, plan Crece y ficha CRM reales, con la API
bajo `iaxti_app` (sin SUPERUSER/BYPASSRLS) y datos sintéticos. Gmail/OAuth se
interceptan en el navegador: estas imágenes no prueban la conexión a Google.

- `conectar`: control alcanzado con Tab desde el documento, foco CSS visible.
- `callback`: PKCE S256 verificado, state/nonce, query retirada, no-referrer,
  sessionStorage consumido y un solo canje. Enlace con contraste mínimo 4.5.
- `hilos`: dos asuntos/extractos sintéticos, fechas ordenadas, watch pendiente dicho.
- `error`: error de lectura con código/rastro y reintento, sin falso estado vacío
  ni falso «Sin conectar» mientras el grant permanece activo.
- `vacio`: consulta exitosa sin hilos y acción explícita para consultar de nuevo.
- `revocar`: alcance global de permisos Google visible, foco por Tab y texto del
  botón contenido dentro de su rectángulo; revocación ejecutada con Enter.

La prueba también exige ausencia de overflow horizontal, solo contactId/refresh
como parámetros de consulta y eliminación del contenido tras revocar. Los DOM
cubren respuestas tardías al cambiar sesión, negocio o contacto. Las pruebas SQL
cubren aislamiento usuario/tenant, dueño, supresión, revocación y carreras push.

Inspección visual: contenido de día, error de noche, modal de revocación de noche y
conectar de día legibles, sin recortes. Los restantes estados tienen aserciones
funcionales y capturas para revisión. No se usaron credenciales ni correos reales.

Reproducción con PostgreSQL/Redis de ensayo y Node 22/pnpm del proyecto:

```sh
TODO=1 pnpm antes-de-empujar
pnpm --filter @iaxti/web e2e gmail.spec.ts
```

El arnés admite E2E_API_PORT/E2E_WEB_PORT/E2E_JWKS_PORT para aislar puertos y
APP_DATABASE_URL para ejecutar la API con rol RLS separado del migrador. Esta
corrida usó 4051/4052/4053, Redis 14 y una base exclusiva de prueba. No iniciar
el worker ni configurar credenciales Google reales para estas pruebas.
