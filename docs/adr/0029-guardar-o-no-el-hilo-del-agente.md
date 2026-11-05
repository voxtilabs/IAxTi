# 0029 · ¿Se guarda el hilo del Agente General?

Estado: **propuesta** · decide el dueño del producto · nace de #1129 y abre #1131

## Por qué existe esta página

`agente-general.controller.ts` dice, textual:

> El hilo lo manda el cliente: acá no hay sesión guardada, y eso es a propósito
> — una conversación de configuración no es un dato del negocio que haya que
> retener.

Esa decisión era correcta cuando se tomó, y #1129 le cambió el contexto debajo.
No la reviso por gusto: la reviso porque el hecho que la sostenía dejó de ser
cierto.

## Qué cambió

El Agente General era un popup. Se abría, se pedía algo, se cerraba. Que el
hilo se perdiera al cerrarlo era coherente: nadie esperaba volver.

Desde #1129 la conversación **es** la pantalla «Tu asistente» — que es lo que
ADR-0025 §1.2 pedía desde el 25/09 al llamarla «la vía de configuración
universal». Y ahí la expectativa es otra: es donde el dueño configura su
negocio, y configurar un negocio no se hace de una sentada.

Hoy el hilo sobrevive a cerrar el popup y a navegar entre pantallas. No
sobrevive a recargar.

## El caso que de verdad duele

No es perder la charla. Es esto:

El agente **propone** acciones y el humano las aprueba — ADR-0025 y ADR-0017.
Una propuesta sin resolver que desaparece en un F5 deja al dueño sin saber qué
le habían ofrecido. No pierde una conversación: pierde una decisión pendiente,
y ni siquiera se entera de que la tenía.

Eso no es un inconveniente de comodidad; es el producto perdiendo algo que
había puesto sobre la mesa.

## Las tres salidas

### A · Se queda como está

El hilo vive en memoria y se pierde al recargar. Cero código, cero datos
nuevos, la decisión original intacta.

Lo que cuesta: el caso de arriba, cada vez.

### B · Guardarlo en el navegador

`sessionStorage`, por pestaña, borrado al cerrarla.

A favor: no crea dato de negocio en el servidor, así que la decisión original
—«no es un dato que haya que retener»— se sostiene entera.

En contra, y hay que decirlo: el hilo lleva lo que el dueño contó de su negocio
y lo que el agente propuso tocar. Que eso quede escrito en el disco del
navegador es una exposición nueva frente a tenerlo solo en memoria, aunque sea
el mismo computador donde la app ya está abierta. Y no cruza dispositivos: el
dueño que empieza en el escritorio no sigue en el teléfono.

### C · Guardarlo en el servidor

Tabla por `tenant_id` y persona, con RLS e índice que empiece por `tenant_id`,
como toda tabla de negocio. Una fila por persona y negocio, reemplazada en cada
vuelta, así que el tamaño está acotado por diseño.

A favor: cruza dispositivos, se audita como todo lo demás, y las propuestas sin
resolver se recuperan **con su estado**.

En contra: **es exactamente lo que la decisión original dijo que no**. Crea un
dato de negocio con PII —lo que el dueño contó— que hay que retener, borrar por
política (SPEC §39) y entregar si el titular lo pide. Deja de ser una
conversación y pasa a ser un registro.

## Lo que recomiendo, y por qué

**C, acotada.** El argumento no es la comodidad: es que una propuesta pendiente
ya es un compromiso del producto con el dueño, y los compromisos se guardan.
Que el hilo venga de arriba es lo que lo hace recuperable.

Acotada quiere decir: una fila por persona y negocio, reemplazada; retención
corta y explícita, no «para siempre»; y el mismo borrado que el resto cuando el
titular lo pide.

Si la respuesta es que no vale el dato nuevo, **A** es preferible a **B**: B
paga la misma exposición que C sin ninguna de sus ventajas, y encima deja la
decisión a medio tomar.

## Lo que hace falta decidir

1. A, B o C.
2. Si es C: cuántos días. Sugiero **30** — un ciclo de configuración entra
   holgado y no se vuelve un archivo histórico.
3. Si es C: si el hilo entra en la exportación de datos del titular. Creo que
   sí: es texto que la persona escribió.

Mientras no se decida, el código se queda en A, que es lo que hay.
