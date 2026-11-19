# Salir del intermediario de canales

Esto ya ocurrió: Zavu salió del código el 19-11 (#1339) y Zernio es hoy el
único transporte (ADR-0032 y 0033, epic #1338). Este documento empezó como la
respuesta a «¿estamos atrapados?» cuando Zavu todavía estaba; queda como el
registro de cómo se salió y como el playbook para la próxima vez que haya que
cambiar de transporte.

## Cómo se salió

La premisa de la ADR-0014 —omnicanal como diferenciador— no se cumplió: se
pagó el plan de Zavu y no entregaba Instagram (#1327). La salida costó lo que
este runbook predecía, ni más ni menos:

1. **El adaptador nuevo** (#1317): `send`, `verifyWebhook`, `normalize` y el
   núcleo de seguridad en `zernio-base`. El vocabulario de Zernio no cruza el
   adaptador: hacia adentro solo salen las formas del puerto.
2. **El archivo del envío**: `apps/workers/src/outbound.ts` llama a
   `deliverOutbound` por su nombre. Se pasó por ahí, como estaba anotado.
3. **Las credenciales**: por referencia desde el principio, así que fue
   cambiar el nombre de la variable en cada cuenta, no migrar secretos.
4. **Los webhooks**: cada cuenta ya tenía su URL propia
   (`/webhooks/channels/<id>`) y su secreto por referencia. Nada global que
   reapuntar.
5. **La base**: el proveedor pasó a ser atributo de la cuenta (ADR-0032). Las
   cuentas que pasaron por Zavu siguen declarando `provider = 'zavu'` —su
   historia, no se les miente— y una que quede viva grita al arrancar en la
   lista de proveedores sin adaptador.

Lo que no hubo que tocar, como decía la versión anterior: **la bandeja, el
copiloto, las automatizaciones, los reportes.** Ninguno sabe de quién viene
un mensaje.

Lo que el cambio se llevó y no ha vuelto: Zernio todavía no publica estados
de entrega ni calidad del número (#43), y las plantillas aún no tienen puerto
para Zernio — va en su propio issue, y mientras tanto una cuenta en Zernio no
ofrece plantillas. `sincronizarConZavu` se fue con Zavu, como decía este
documento: era una peculiaridad de Zavu —su copia se quedaba atrás de Meta— y
no una operación que todo transporte tenga. Instagram y Messenger siguen sin
validación con cuentas reales (#74): con Zavu nunca se hizo, y por Zernio
tampoco hay ninguna hecha.

## Lo que está detrás del puerto

`ChannelProvider` abstrae lo que un canal hace:

| Operación | Quién la usa | Portable |
|---|---|---|
| `send` | cola `outbound`, vía `deliverOutbound` | sí, con el matiz de abajo |
| `verifyWebhook` | webhook de entrada | sí |
| `normalize` | webhook de entrada | sí |
| `plantillas.crear` / `enviarARevision` / `listar` | API y barrido | sí (#159); el adaptador de Zernio todavía no las implementa |

Las plantillas eran el agujero grande: la API y el worker llamaban a
`crearEnZavu`, `enviarARevisionEnZavu` y `listarEnZavu` **por su nombre**. O
sea que el plan de salida era «cambiar un adaptador» en la mitad del producto
y una reescritura en la otra mitad — y eso no se ve hasta el día que hay que
hacerlo. Hoy pasan por el puerto, y `puerto-de-plantillas.test.ts` lo prueba
con un proveedor inventado que no tiene una línea de Zavu.

## Lo que todavía NO está detrás del puerto

**El envío.** `apps/workers/src/outbound.ts` llama a `deliverOutbound` del
módulo whatsapp directamente. No es un descuido: ese camino tiene reintento
con política, pausa por calidad del número, ventana de 24 h y traducción de
las causas de Meta — cosas que no son «mandar un mensaje» sino «mandar un
mensaje por WhatsApp». Meterlas en `send` le inventaría a los otros canales
una obligación que no tienen.

La consecuencia sigue siendo la misma: **el proceso que de verdad envía es
el que menos usa la abstracción.** Cambiar de transporte obliga a tocar ese
archivo.

Los workers registran sus adaptadores desde #159; antes no registraban
ninguno, y nadie lo notó porque el envío no pasaba por el registro.

## El playbook para la próxima

Lo que hizo barata esta salida, en orden:

1. **El puerto primero.** Las operaciones del canal por `ChannelProvider`, y
   una prueba con un proveedor inventado que no tiene una línea del
   transporte viejo: el plan de salida no puede ser «cambiar un adaptador»
   en la mitad del producto y una reescritura en la otra.
2. **Proveedor por cuenta, no por despliegue** (ADR-0032). Migrar una cuenta
   a la vez y poder volver atrás con un `UPDATE`.
3. **Credenciales y webhooks por cuenta.** Nada global que reapuntar.
4. **Medir por el puerto del producto** (#870): el transporte nuevo está
   «probado» cuando una cuenta real manda y recibe por el camino entero, no
   cuando su documentación lo promete. Con Zavu quedó la diferencia a la
   vista: prometía Instagram y no lo entregaba (#1327).

Y la respuesta a la pregunta que abrió este documento, dicha con el caso
trabajado: **no, no estamos atrapados — salir cuesta un adaptador y el
archivo del envío.**
