# #56 · Alta inicial y reanudación del onboarding

Este cambio **no cierra #56**. Completa el alta inicial autenticada, la reanudación
de la descripción en el configurador y la lectura de costos durante el trial.
La invitación de Zavu, el primer mensaje real y la demostración en staging siguen
pendientes. No se ha enviado un mensaje ni conectado una cuenta externa.

Dependencia técnica: PR #928, base `8683f00e7dfee8542d5106cdaf4b84a4995e4773`.
Los contratos de autorización y el bootstrap de lectura de membresías vienen de
esa base; el diff de #56 no vuelve a implementarlos.

## Comportamiento comprobable

- `POST /v1/onboarding/registro` exige JWT humano, cuerpo validado y
  `Idempotency-Key`. El usuario, tenant, rol y plan no se eligen en el cuerpo.
- La primera alta usa Crece, trial de 14 días y ADMIN inicial, según SPEC §6/§9
  y los contratos existentes. Tenant, perfil, membresía, outbox, auditoría y
  referencia de reintento se confirman o revierten juntos.
- Los reintentos concurrentes devuelven el mismo negocio. Un usuario ya invitado
  conserva su rol; una referencia de alta no restaura un acceso revocado.
- El formulario aparece solo después de que `/me` confirme ausencia de negocios.
  Errores, carga y respuestas obsoletas tienen caminos propios. La descripción
  y el rubro persisten en el tenant y se recuperan al abrir el configurador.
- Cambiar usuario o negocio desmonta la instancia anterior del configurador y
  aborta sus solicitudes. Un POST anterior no borra la propuesta del nuevo
  negocio. Aplicar/descartar comparte un bloqueo contra doble clic.
- `GET /v1/onboarding/costos` lee Meta agregado e IA del mes sin crear una
  suscripción, factura ni cobro. Muestra consumo registrado, no una promesa de
  cero ni una factura. El trial y sus fechas se leen del tenant. El panel aparece
  en la puesta en marcha y dentro del configurador después de aplicar, también
  al retomar una propuesta ya aplicada.

## Estado de los criterios originales

| Criterio de #56 | Estado de este cambio |
|---|---|
| Flujo guiado persistido y retomable | Parcial: alta y descripción reanudables; el progreso existente se conserva. Falta el tramo Zavu. |
| Registro Google, tenant y descripción/vertical | Alta posterior al JWT implementada y comprobada localmente; el login Google existente no se ha ejercitado con una cuenta externa. |
| Configurador con propuesta y antes/después aplicado por usuario | Se reutiliza el flujo existente; se añade descripción inicial y aislamiento de respuestas por contexto. No se acredita una ejecución real de proveedor IA en esta evidencia. |
| Partner invitation y cuenta automática por completed | Pendiente; no se añade un callback incompleto. |
| Mensaje entrante de prueba con sugerencia de copiloto | Pendiente de conexión real y proveedor IA. |
| Staging cronometrado menor de diez minutos y video | Pendiente; las pruebas locales no lo sustituyen. |
| Costos Meta/IA visibles al completar configuración | Lectura y panel implementados, visibles también durante la puesta en marcha. Validación con datos sintéticos identificados. |

## Límite contractual de Zavu

Fuentes oficiales consultadas el 16-10-2026:
[invitaciones](https://docs.zavu.dev/guides/partner-invitations-api),
[configurar webhook del proyecto](https://docs.zavu.dev/api-reference/configure-project-webhook),
[actualizar emisor](https://docs.zavu.dev/api-reference/update-sender),
[OpenAPI oficial](https://docs.zavu.dev/openapi.json).

`POST /v1/invitations` no documenta metadata de correlación ni una llave de
idempotencia. El evento `invitation.status_changed` aporta proyecto, invitación,
estado y emisor; la correlación debe persistirse antes de confiar en el evento.
El webhook de proyecto solo admite eventos de invitación, broadcast y dominio:
no recibe `message.inbound`. El PATCH de emisor no acepta fijar `webhookSecret`;
su rotación devuelve un secreto generado que necesita custodia segura.

El repositorio usa referencias a secretos estáticos de entorno y no tiene un
almacén dinámico para el secreto del emisor que acaba de crearse. Este cambio no
inventa ese contrato, no guarda secretos en PostgreSQL ni marca una cuenta como
activa sin poder recibir mensajes. Una creación remota con respuesta perdida
tampoco puede repetirse a ciegas suponiendo idempotencia no documentada.

## Validación y reproducción

Pruebas de API: `apps/api/tests/onboarding-registration.test.ts` y
`apps/api/tests/jwt-only.test.ts`. Incluyen RLS con rol propio sin superusuario ni
BYPASSRLS, ocho altas concurrentes, reintentos, aislamiento, acceso revocado,
rollback forzado por trigger de auditoría y lectura sin efectos de facturación.

Pruebas DOM: `apps/web/tests/registro-inicial.test.tsx` y
`apps/web/tests/configurador-contexto.test.tsx`. Prueba de navegador:
`apps/web/e2e/onboarding-registration.spec.ts`, contra API/PostgreSQL reales y
JWKS local declarado como sustituto de Supabase. El proveedor Google no participa.

```sh
pnpm install --frozen-lockfile
pnpm antes-de-empujar --filter=@iaxti/api --filter=@iaxti/web \
  --filter=@iaxti/module-organizations --filter=@iaxti/module-billing \
  --filter=@iaxti/sdk --filter=@iaxti/module-agents
E2E_API_PORT=4021 E2E_WEB_PORT=4022 E2E_JWKS_PORT=4023 \
  pnpm --filter @iaxti/web e2e onboarding-registration
```

Estos comandos requieren una base de pruebas y Redis aislados. La validación
local usa `iaxti_test_56` y Redis8. El arnés permite `E2E_APP_DATABASE_URL` para
que la API use un rol sin BYPASSRLS mientras las fixtures migran con el dueño.
Las rutas del SDK se regeneran desde OpenAPI con
`node scripts/generate-onboarding-registration.mjs <openapi.json>`; una prueba
contrasta cada operationId contra la API levantada.

Preflight local del 16-10-2026: **1725 aprobadas, 14 omitidas, 0 fallos**.
Desglose: API 475 + 4 omitidas, web 342, agents 441, organizations 26,
billing 41, db 52 y core 348 + 10 omitidas. Las omisiones pertenecen a las
suites existentes. Typecheck 30 tareas, build 26 tareas, lint, fronteras entre
módulos y los trinquetes pasaron. Las 99 migraciones también se aplicaron
sobre una base virgen. Las cuatro advertencias de lint existentes no se
suprimieron; no se añadieron advertencias nuevas.

El navegador usa una segunda base aislada (`iaxti_test_56_browser`) creada con
las migraciones finales y un rol de API propio sin superusuario ni BYPASSRLS.
Resultado: **2 aprobadas, 0 fallos** (día y noche). Las variantes comprueban
alta real, una membresía ADMIN, costos, recarga y
descripción recuperada. No se sustituyen respuestas de API en el navegador.
Los tests DOM del configurador sí simulan la propuesta y su aplicación: no
representan una llamada a un proveedor IA.

Capturas del navegador, datos sintéticos, 360 px:

- [Registro día](registro-dia-360.png) · [registro noche](registro-noche-360.png).
- [Costos día](costos-dia-360.png) · [costos noche](costos-noche-360.png).

Revisión local de `/module-check`, `/security-review`, `/ui-check` y
`/rule-check`: sin hallazgos abiertos dentro del delta comprobado. Los imports
cruzados usan contratos; no hay secretos nuevos ni envíos; la auditoría y el
aislamiento se ejercitan con PostgreSQL. Se corrigieron respuestas obsoletas del
configurador, exclusión del alta del catálogo IA y contraste del enlace usando
`text-action-text`. El catálogo generado y el baseline de avisos se regeneraron
con sus scripts; no se cambiaron assertions para ocultar fallos.

## Revisión SPEC §34

1. Contratos públicos entre módulos; composición en API, sin escrituras ajenas.
2. Endpoints con módulo y OpenAPI. Alta inicial usa sesión JWT estricta antes
   del tenant; lecturas usan `tenant.settings` y `tenant.billing`.
3. Alta, rol y auditoría comparten transacción; fallo de auditoría probado.
4. Tabla nueva con tenant, RLS forzado e índice que empieza por tenant.
5. Migración 0006 aditiva; no cambia tablas previas.
6. API, DOM, navegador y guardas; no cambia manifiestos ni relaja assertions.
7. El alta no se expone como tool de agente: se clasifica en el catálogo
   productivo `NO_SON_HERRAMIENTA`, junto a las puertas personales de sesión,
   con motivo y regresión. No crea negocios ni asigna ADMIN desde una IA.
8. No añade envíos ni altera consentimiento, ventana ni horario.
9. No cambia prompts, precios, stock ni herramientas de IA.
10. Controles compartidos y tokens Pulso; sin hex, sombras ni tema local.
11. Capturas a 360 px día/noche, teclado, foco y montos en mono.
12. Sin secretos ni cuentas reales. JWT de prueba solo en `.auth.json` ignorado.
13. ADR-0008, inventario y baseline de compliance actualizados.
14. Referencia #56 sin declaración de cierre; commit convencional y PR a staging.
