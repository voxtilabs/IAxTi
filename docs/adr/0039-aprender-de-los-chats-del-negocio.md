# ADR-0039 · Aprender de los chats del negocio: se pregunta, se redacta, se revisa

- **Estado:** aceptada
- **Fecha:** 2026-11-26
- **Issue:** #1406 (depende de #1405)
- **Cambia:** nada del SPEC. Agrega una fuente de conocimiento nueva y un
  estado de revisión a las fuentes; aplica la redacción de SPEC §13 a un
  camino nuevo hacia el proveedor de IA.

## Contexto

Lino quiere que, al conectar el WhatsApp, IAxTi lea los **últimos 50 chats**
del negocio para que el asistente aprenda qué le preguntan y cómo responde, y
que **pregunte antes**.

Medido en la spec de Zernio (v1.853, 26-11):

- El historial existe **solo en coexistencia**. Al conectar un número que vive
  en la app WhatsApp Business, Zernio le pide a Meta el historial del teléfono.
  El estado está en `GET /v1/accounts/{id}/health` → `coexistenceHistorySync`
  (`requested`, `imported`, `declined`, `already_synced`, `refused`). Meta lo
  comparte **una vez por número**.
- Queda en el inbox de Zernio, y la llave restringida del negocio lo puede leer
  (`/v1/inbox/conversations`, `/messages`).

Son conversaciones de los **clientes de la pyme**: nombres, teléfonos, a veces
direcciones o datos de pago. La pyme es responsable de esos datos, IAxTi los
trata por encargo suyo, y el proveedor de IA está un paso más afuera.

## La decisión

**IAxTi puede aprender de los últimos 50 chats de un número en coexistencia,
con cuatro reglas que no se negocian:**

1. **Se pregunta antes.** Lo autoriza explícitamente un ADMIN del negocio, por
   número, en Canales o en la puesta en marcha. Queda en `audit_log`
   (`whatsapp.historial.autorizado`, con quién y cuándo) y en la cuenta. Sin
   esa marca, el job no llama a Zernio. Retirar la autorización corta el job
   pendiente.
2. **Los chats no se guardan.** Se leen en memoria, se **redactan antes de
   salir al proveedor de IA** (teléfonos, correos, RUT, números de tarjeta) y
   se descartan. Lo único que queda en IAxTi es lo extraído:
   - preguntas frecuentes y cómo las responde el negocio;
   - el tono.

   La redacción vive en un solo lugar (`redactPII`, ampliada) y tiene una
   prueba que mira el cuerpo HTTP que sale al proveedor (el patrón de
   `el-cuerpo-que-sale-al-proveedor.test.ts`).
3. **La dueña revisa antes de que el asistente lo use.** Lo aprendido nace como
   una fuente de conocimiento en estado **`por_revisar`**, que la búsqueda del
   asistente no lee. Se aprueba, edita o descarta entrada por entrada. Un
   precio visto en un chat puede estar viejo: la entrada lo dice («visto en un
   chat del dd-mm; confírmalo») y la regla de siempre sigue en pie, la IA no
   inventa precio.
4. **Se puede borrar.** Borrar la fuente borra lo aprendido, por el mismo
   camino que cualquier otra fuente (SPEC §39).

**Alcance:** los 50 chats más recientes, con sus últimos 30 mensajes de texto
cada uno. Sin adjuntos, audios ni grupos. El costo de IA queda en el consumo
del negocio, visible como cualquier otro.

## Lo que se descartó

- **Importar los chats a la bandeja** como conversaciones de IAxTi. Llenaría la
  bandeja de hilos viejos, crearía contactos sin el consentimiento de siempre
  (nacen de un historial, no de un mensaje nuevo) y no es lo que se pidió: se
  pidió una fuente para la IA.
- **Guardar los chats crudos** para reprocesarlos después. Es la opción más
  cómoda y la que más datos de terceros deja en reposo. Si se quiere
  reaprender, se vuelve a leer de Zernio con una autorización nueva.
- **Usar lo aprendido sin revisión.** Contradice el principio del producto
  (propone y una persona manda), y un precio viejo dicho por el asistente es
  justo lo que la regla de la casa prohíbe.

## Consecuencias

- Un número conectado por **API** (#1405) no tiene historial. La pantalla lo
  dice en vez de ofrecer algo que no puede pasar.
- Si Meta responde `already_synced`, la pantalla da los pasos de Zernio:
  desconectar en la app (Ajustes → Cuenta → Business Platform) y conectar de
  nuevo.
- Lo que sale al proveedor de IA son extractos redactados. Una regex no ve
  todo: un nombre propio o una dirección escrita a mano pueden pasar. Por eso
  lo extraído pasa por la revisión de la dueña antes de usarse, y la fila de
  compliance lo dice.
