# Issue #74 · conexión de Instagram y Messenger por Zavu

Referencia: [issue completa y comentario](https://github.com/voxtilabs/IAxTi/issues/74). Corte: 16-10-2026. Este cambio corrige faltantes de código comprobados; **no cierra #74, no certifica cuentas reales y no autoriza su lanzamiento**. El criterio de paridad con WhatsApp continúa pendiente.

El comentario de septiembre decía que solo faltaba configuración. En el código de partida, `conectarSender` ignoraba `kind` y creaba siempre un número de WhatsApp; la prueba de envío normalizaba todo destinatario como teléfono; la conexión no tenía entrada para Instagram/Messenger en Canales. Además, un sender multicanal tiene un único webhook: cambiarlo al conectar su segundo canal desplazaba al primero.

## Trazabilidad de los cinco criterios originales

| Criterio original | Implementación y evidencia | Estado y límite |
|---|---|---|
| Instagram DM y Messenger enviando y recibiendo por el adaptador del #42, sin un verificador de firma nuevo | `whatsapp/application/conectar.ts` respeta `kind`; `zavu.ts` conserva canal e identidad en texto y rechaza adjuntos/plantillas antes de cualquier POST. `api/src/cuenta-de-webhook-zavu.ts` elige el destino después del verificador existente. Pruebas `conexion-meta.test.ts` y `canales-meta-74.test.ts`: HTTP local, firma V2, canal correcto, sender ajeno rechazado y receptor primario archivado. | Código y contratos locales comprobables. Pendiente envío/recepción y estados con cuentas reales del proveedor. No se simuló esa aceptación. |
| Conexión de cuenta desde la pantalla de canales; credenciales referenciadas | Canales consulta solo emisores acreditados al tenant y permite conectar cada capacidad que Zavu confirma. No acepta referencias de secretos ni lista el catálogo global. API comprueba refs existentes, ambiente y webhook configurado antes de activar. Roles, carreras y auditoría se ejercitan con PostgreSQL/RLS. | Flujo local implementado. El alta/autorización inicial de Instagram en el dashboard de Zavu y el paso operador siguen siendo necesarios; no existe un alta Instagram por API documentada que se haya inventado aquí. |
| Mensajes en la misma bandeja con ícono de canal; el copiloto funciona igual | Se reutilizan `ChannelProvider`, cola inbound, identidad por canal, conversaciones y copiloto existentes. `CanalChip` identifica las opciones; la Bandeja conserva texto y muestra la restricción de adjuntos. DOM `chat-meta-74.test.tsx` cubre texto, pegar archivo rechazado y ventana cerrada; el HTTP firmado verifica la cuenta y canal del job. | No se duplica bandeja ni IA. Falta certificar el recorrido completo de copiloto y recepción real de ambos canales con proveedor/modelo configurados. |
| Reglas de ventana de mensajería de cada canal respetadas (equivalente a la de 24 h) | Se conserva `isWithinWindow`; la prueba busca identidad del canal y ventana de la cuenta exacta. Las pruebas rechazan 25 h y muestran que un inbound por otra cuenta no abre la anterior. Bandeja no ofrece plantillas WhatsApp en IG/Messenger al vencer su ventana. | Regresiones locales implementadas; se mantienen silencio y consentimiento existentes. |
| Se lanzan solo cuando funcionan igual de bien que WhatsApp (criterio de la sección 12) | La API oficial de mensajes de Zavu indica que un tipo distinto de texto selecciona WhatsApp. El adaptador impide ese desvío y la UI no promete subir adjuntos. | **Pendiente.** Texto con dobles locales no demuestra paridad; no se declara lanzamiento ni issue completa. Medios y pruebas reales requieren contrato/capacidades del proveedor y cuentas autorizadas. |

## Contratos y operación

- `GET /v1/channels/conexiones-disponibles`: permiso `channels.manage`, módulo `whatsapp`, tenant autenticado. Solo devuelve `{senderId, kind, name}` de reservas propias y canales confirmados por `GET /v1/senders/{id}`.
- `POST /v1/channels/conectar`: mismo guard; cuerpo `{senderId, kind}` con `instagram|messenger`. No recibe secretos ni sus referencias. Activa después de corroborar configuración y conserva actor de usuario/API key. Dos activaciones simultáneas serializan la reserva y reutilizan la misma cuenta.
- `channels.reservarEmisor(PoolClient, …)` conserva una reserva global por sender y dueño por tenant, y una única cuenta receptora de webhook. Cuenta, reserva, evento y audit comparten transacción. La FK compuesta impide asociar una reserva a una cuenta ajena incluso mediante SQL directo.
- La migración `channels/0004` es aditiva y conserva las columnas anteriores. Precarga dueño y receptor para emisores con una sola cuenta. Con varias cuentas del mismo tenant conserva el dueño y guarda receptor nulo, exclusivamente para ese caso histórico: mantiene el ingreso firmado sin inventar receptor y deja la acreditación pendiente del operador; si detecta un sender entre varios tenants aborta en vez de elegir un dueño. La regresión aplica el SQL real en una base efímera y el HTTP comprueba la entrada por la segunda cuenta histórica. Archivar una cuenta no libera el sender ni mueve el webhook. Reapuntar el receptor de un emisor compartido se rechaza y revierte el cambio del número; reapuntar una cuenta sola conserva la propiedad anterior, pero no ofrece el receptor antiguo para añadir canales nuevos. Se conserva el comportamiento WhatsApp por defecto; el nuevo flujo necesita la migración antes de arrancar esta versión.
- Los eventos explícitos de Zavu solo seleccionan canal después de comprobar la firma existente. Un destino ambiguo o de otra reserva se rechaza; los sobres históricos sin canal mantienen su receptor y no habilitan un cruce de canal.

Tramo operador existente, no ejecutado contra Zavu durante estas pruebas:

1. Autorizar la cuenta de Instagram o la página de Messenger en el dashboard del proveedor, con los permisos que exige Zavu. El operador comprueba qué negocio posee ese sender; conocer un id no acredita a un tenant.
2. Guardar la llave y secreto del webhook en el mecanismo de variables/referencias existente. No se añadió almacenamiento de secretos. Preparar el sender verificado mediante el CLI existente, por ejemplo:

   ```sh
   pnpm zavu:conectar --tenant <uuid-del-negocio> --sender <id-verificado> --kind instagram --nombre "Cuenta del negocio" --base-url <url-publica-api> --credential-ref <nombre-variable-llave> --webhook-secret-ref <nombre-variable-firma>
   ```

   El comando recibe nombres de variables, nunca valores. Para `--sender` consulta el detalle exacto, aunque no esté en la primera página del listado. Instagram/Messenger quedan `connecting`; no se crea un número WhatsApp ni se regenera un secreto. Al añadir otro canal del mismo sender se conservan receptor y referencias originales, sin PATCH ni rotación. La preparación inicial del webhook es una operación externa del CLI y no forma parte de una transacción distribuida con Zavu.
3. En Canales, completar la conexión acreditada. La aplicación verifica capacidad, ambiente, referencias y URL/estado del webhook. Esto verifica configuración, **no** sustituye la prueba real de recepción y respuesta exigida por la issue.

## Fuentes oficiales comprobadas

- [Añadir canales a un sender](https://docs.zavu.dev/guides/senders/adding-channels): autorización desde el dashboard, permisos de la cuenta/página, identificadores propios y ventanas.
- [Detalle de sender](https://docs.zavu.dev/api-reference/get-sender): respuesta plana, canales configurados y webhook compartido.
- [Enviar mensaje](https://docs.zavu.dev/api-reference/send-a-message): canal explícito para texto; los tipos no textuales seleccionan WhatsApp. No se inferieron capacidades de medios a partir de Meta Graph.
- [Invitaciones de partners](https://docs.zavu.dev/guides/partner-invitations/api): WhatsApp/Messenger; no documenta alta Instagram por invitación. Este cambio no implementa #56 ni #158.

## Verificación local y alcance

Los tests usan datos ficticios, PostgreSQL aislado y servidor HTTP local como proveedor. Los tests nuevos de RLS crean roles propios sin superusuario/BYPASSRLS; no sustituyen silenciosamente ese rol por el owner cuando Turbo filtra variables. Los tests DOM usan el hook real `useCarga` y el cliente real `apiFetch`, interceptando la frontera fetch. Los E2E de conexión interceptan las rutas nuevas para medir UI; la prueba HTTP/RLS es independiente.

Comandos del repositorio (entorno de pruebas configurado):

```sh
pnpm install --frozen-lockfile
pnpm --filter @iaxti/module-channels exec vitest run tests/emisor-compartido.test.ts tests/migracion-emisor.test.ts
pnpm --filter @iaxti/module-whatsapp exec vitest run tests/conexion-meta.test.ts tests/el-numero-del-negocio.test.ts
pnpm --filter @iaxti/api exec vitest run tests/canales-meta-74.test.ts
pnpm --filter @iaxti/web exec vitest run tests/conectar-canales-meta.test.tsx tests/chat-meta-74.test.tsx
E2E_API_PORT=4024 E2E_WEB_PORT=4025 E2E_JWKS_PORT=4026 pnpm --filter @iaxti/web e2e canales-meta-74 --workers=1
pnpm antes-de-empujar
```

Resultado del corte final: `antes-de-empujar` terminó con código 0 sobre los 30 paquetes, sin filtros manuales. Tipos 54/54 tareas, build 30/30 y 2.921 tests aprobados en 28 paquetes; 14 omitidos existentes (10 comprobaciones XLSX sin `openpyxl` y 4 de API). Las guardas de esquema/core se repitieron fuera de caché; catálogo, 98 migraciones sobre base virgen y todos los trinquetes terminaron verdes. Hubo avisos de lint existentes, sin errores. Los conjuntos dirigidos suman 45 tests aprobados (5 reserva/migración, 20 conexión/reapunte WhatsApp, 7 HTTP y 13 DOM), incluidos en el preflight; el E2E adicional aprobó 2/2 escenarios.

La crítica independiente identificó y verificó la corrección de tres casos: no inferir el receptor histórico compartido, no reapuntar un receptor que mantiene otros canales y evitar el sombreado de tabla en la función de resolución. El test de migración incluye una tabla temporal homónima y confirma que se consulta la tabla pública. El control final se ejecutó después de esas correcciones; no equivale a CI remota ni a una prueba de proveedor real.

Security-review/module-check/rule-check/ui-check: nueva tabla inventariada y exportada; RLS/FK/roles y auditoría transaccional; ningún verificador duplicado ni secreto nuevo; dependencia `channels → audit` declarada y prueba genérica de combinaciones; composición entre módulos desde API por contratos; catálogo OpenAPI regenerado. Se actualizan las filas técnicas de aislamiento/auditoría de `COMPLIANCE_BASELINE`, sin declaraciones legales. Los trinquetes de avisos y exports se regeneran con sus scripts, sin aumentar excepciones.

## Capturas y medidas

Capturas de los componentes, no de toda la aplicación; viewport 360 × 900. Datos y cuentas ficticios. El foco se alcanza con Tab/Enter, sin `.focus()` programático. No se envía la prueba del formulario a un proveedor real.

| Estado | Día | Noche |
|---|---|---|
| Cargando | [captura](conexion-dia-carga.png) | [captura](conexion-noche-carga.png) |
| Opciones y foco | [captura](conexion-dia-lista-foco.png) | [captura](conexion-noche-lista-foco.png) |
| Vacío | [captura](conexion-dia-vacio.png) | [captura](conexion-noche-vacio.png) |
| Falla con rastro | [captura](conexion-dia-falla.png) | [captura](conexion-noche-falla.png) |
| Sin permiso | [captura](conexion-dia-sin-permiso.png) | [captura](conexion-noche-sin-permiso.png) |
| Prueba con id del canal | [captura](conexion-dia-prueba-id.png) | [captura](conexion-noche-prueba-id.png) |

Medidas reproducibles: [día](medidas-dia.json), [noche](medidas-noche.json). El primer pase encontró 58,36 px de diferencia carga/vacío; se acortó la explicación visible y se mantuvo el paso operador en esta documentación. El marco final mide 384 px en carga, opciones y vacío en ambos modos: diferencia 0 px, dentro de la tolerancia de 1 px. No hay desborde horizontal a 360 px. El resultado final de comandos y SHA se registra en el informe de la tarea.
