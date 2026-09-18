# ADR 0016 · Mensajes transaccionales y horario de silencio

**Estado:** aceptada · 2026-09-18

## Contexto

La regla de negocio dice, sin matices:

> **Horario de silencio** (21:00–8:00 por defecto, configurable, no
> desactivable): NADA iniciado por el negocio se envía — recordatorios,
> seguimientos, plantillas, campañas. Se difiere al siguiente horario válido.
> Responder a un cliente que escribió sí se puede.

El código la aplica en la cola de salida con un booleano del job,
`initiatedByBusiness`. Quien encola decide.

Arreglando #277 —el aviso de "pago recibido" que se marcaba enviado y nunca
salía— apareció un caso que ninguno de los dos valores describe bien.

Un comprobante de pago **no lo inicia el negocio**: lo dispara el cliente al
pagar. Y no es "responder a un cliente que escribió": no escribió, pagó. La
regla tiene dos casillas y esto es un tercero.

Las dos salidas obvias fallan por lados distintos:

- **`initiatedByBusiness: true`** difiere el comprobante hasta las 8:00. Quien
  paga a las 22:00 se queda sin confirmación toda la noche. El mensaje existe
  para evitar esa incertidumbre y termina produciéndola.
- **`initiatedByBusiness: false`** lo manda al instante, pero de paso se salta
  **la pausa por calidad en rojo** (#45) y cambia lo que `puedeEnviar` permite
  según el estado del tenant. Dos consecuencias que nadie pidió, escondidas en
  un booleano que dice otra cosa.

## Decisión

Se agrega una tercera noción explícita: **mensaje transaccional**.

Un mensaje es transaccional cuando lo dispara una **acción del cliente** y su
contenido es la constancia de esa acción. Hoy: el comprobante de pago. No lo
es un recordatorio, un seguimiento, una campaña ni una plantilla — esos los
decide el negocio y van cuando el negocio puede hablar.

Un mensaje transaccional:

- **se salta el horario de silencio.** Quien acaba de actuar está despierto, y
  la constancia de lo que hizo pierde su valor si llega doce horas después.
- **NO se salta la pausa por calidad en rojo.** Si Meta tiene el número
  castigado, mandar más es empeorarlo. El comprobante se pierde; el número no.
- **NO se salta el estado del tenant.** Una cuenta suspendida no envía nada,
  ni siquiera esto.
- **NO se salta la ventana de 24 h.** Fuera de ella el proveedor lo rechaza
  igual: la regla no es nuestra.

Sigue siendo `initiatedByBusiness: true` para todo lo demás. Lo transaccional
es una exención de **una** regla, nombrada, no un segundo camino.

## Consecuencias

Un cliente que paga a las 23:00 recibe su comprobante a las 23:00.

La lista de lo transaccional es **cerrada y corta**, y agregar algo a ella es
una decisión, no una conveniencia. La tentación va a ser marcar transaccional
todo lo que alguien quiera que salga ya —"el recordatorio de la hora de
mañana es transaccional, ¿no?"— y no: ese lo decide el negocio. El criterio es
si el cliente hizo algo hace segundos y el mensaje es la constancia.

Si la lista crece más allá de dos o tres, la regla se convirtió en un permiso y
esta ADR hay que revisarla.

## Alternativas descartadas

**Dejar el comprobante fuera de la cola** (como estaba antes de #278): el
mensaje nunca salía y la bandeja decía que sí. Peor que no tenerlo.

**Hacer el horario de silencio configurable por tipo de mensaje**: convierte
una regla en una pantalla de ajustes, y la regla dice explícitamente "no
desactivable". Un tenant que pudiera apagarlo lo apagaría.
