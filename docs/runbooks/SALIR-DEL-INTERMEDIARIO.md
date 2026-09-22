# Salir del intermediario de canales

Hoy los mensajes de WhatsApp, Instagram y Messenger pasan por **Zavu**
(ADR-0014). Este documento dice qué costaría dejar de hacerlo — sea para ir
directo a Meta (#158, #82) o para cambiar de intermediario— y qué hay hecho
para que ese día no sea una reescritura.

No es un plan para ejecutar ahora. Es la respuesta a «¿estamos atrapados?».

## Lo que está detrás del puerto

`ChannelProvider` abstrae lo que un canal hace:

| Operación | Quién la usa | Portable |
|---|---|---|
| `send` | cola `outbound` | **no todavía** — ver abajo |
| `verifyWebhook` | webhook de entrada | sí |
| `normalize` | webhook de entrada | sí |
| `plantillas.crear` / `enviarARevision` / `listar` | API y barrido | sí (#159) |

Las plantillas eran el agujero grande: la API y el worker llamaban a
`crearEnZavu`, `enviarARevisionEnZavu` y `listarEnZavu` **por su nombre**.
O sea que el plan de salida era «cambiar un adaptador» en la mitad del
producto y una reescritura en la otra mitad — y eso no se ve hasta el día
que hay que hacerlo. Hoy pasan por el puerto, y hay un test que lo prueba
con un proveedor inventado que no tiene una línea de Zavu.

## Lo que todavía NO está detrás del puerto

**El envío.** `apps/workers/src/outbound.ts` llama a `deliverOutbound` del
módulo whatsapp directamente. No es un descuido: ese camino tiene reintento
con política, pausa por calidad del número, ventana de 24 h y traducción de
las causas de Meta — cosas que no son «mandar un mensaje» sino «mandar un
mensaje por WhatsApp». Meterlas en `send` le inventaría a los otros canales
una obligación que no tienen.

La consecuencia hay que decirla: **el proceso que de verdad envía es el que
menos usa la abstracción.** Cambiar de proveedor obliga a tocar ese archivo.

Un síntoma de eso apareció acá: los workers **no registraban ningún
adaptador de canal**. La API lo hace desde #41 y los workers nunca, y nadie
lo notó porque el envío no pasa por el registro. Ya quedó registrado.

**La sincronización de plantillas con Meta.** `sincronizarConZavu` sigue
siendo una llamada con nombre propio, a propósito: es una peculiaridad de
Zavu —su copia se queda atrás de Meta y hay que pedirle que se ponga al
día— y no una operación que todo proveedor tenga. El día que Zavu se vaya,
esa línea se va con él.

## Lo que costaría, hoy

1. **Escribir el adaptador nuevo**: `send`, `verifyWebhook`, `normalize` y
   el puerto de plantillas. Es el trabajo declarado y está acotado.
2. **Tocar `outbound.ts`**: mientras la política de reintento y la calidad
   del número vivan ahí, un proveedor nuevo obliga a pasar por ese archivo.
3. **Las credenciales**: por referencia desde el principio, así que es
   cambiar el nombre de la variable en cada cuenta de canal, no migrar
   secretos.
4. **Los webhooks**: cada cuenta ya tiene su URL propia
   (`/webhooks/channels/<id>`) y su secreto por referencia. No hay nada
   global que reapuntar.
5. **Lo que NO se toca**: la bandeja, el copiloto, las automatizaciones,
   los reportes. Ninguno sabe de quién viene un mensaje.

## Lo que falta para poder decir «probado»

Este documento describe el camino y el puerto está probado con un proveedor
falso. Lo que no está probado es un proveedor REAL distinto: eso necesita
credenciales de Meta como Tech Provider (#82) y es el contenido de #158.

Hasta entonces, la respuesta honesta a «¿estamos atrapados?» es: **no, pero
salir cuesta un adaptador y un archivo**, y el archivo es el del envío.
