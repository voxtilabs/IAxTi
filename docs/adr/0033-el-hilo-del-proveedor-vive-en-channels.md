# ADR 0033 · El hilo del proveedor vive en `channels`, y se aprende de lo que entra

**Estado:** propuesta · 2026-11-11 · resuelve #1320, bloquea #1317 · sigue a la
[ADR-0032](0032-un-proveedor-por-cuenta-y-la-puerta-a-zernio.md)

## Contexto

El puerto de canales manda a un **destinatario**:

```ts
send(account, { to: '+569…', body, … }): Promise<{ providerMessageId }>
```

Zernio manda **dentro de una conversación que ya existe**. Medido contra su
OpenAPI (v1.527, 11-11):

```
POST /v1/inbox/conversations                     ← crearla
POST /v1/inbox/conversations/{id}/messages       ← mandar dentro
```

No hay ruta que acepte un teléfono directo. Con Zavu el puerto calza porque su
envelope lleva el destino; con Zernio hace falta conocer —y recordar— el id de
la conversación del lado del proveedor. Ese id es lo que esta ADR llama **hilo**.

### Tres hechos del spec que deciden el diseño

1. **Crear una conversación de WhatsApp exige `templateName`** (salvo el envío
   directo de categoría `utility`). O sea que el único caso en que hay que
   crear un hilo es abrirle a alguien que nunca escribió, y ese caso **ya está
   obligado a ir con plantilla** por nuestra regla de la ventana de 24 h. La
   restricción del proveedor y la nuestra coinciden: no hay un tercer camino
   que diseñar.
2. **Cada webhook entrante trae `message.conversationId`** (y
   `conversation.id`, el mismo valor). La correspondencia se aprende sola cada
   vez que el cliente escribe. En el caso normal —el cliente escribió primero—
   el hilo ya lo conocemos antes de tener que contestar.
3. **Cada webhook trae `profiles[].externalId`**, un valor que pone el que
   integra. Es la pieza que hace falta para #1321 (ver «Lo que esto habilita»).

## Decisión

### 1 · Una tabla de `channels`, no de `conversations`

```sql
channel_threads (
  tenant_id          uuid NOT NULL,
  channel_account_id uuid NOT NULL,
  peer               text NOT NULL,   -- E.164 hoy; ver «Riesgo» más abajo
  provider_thread_id text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_account_id, peer)
)  -- + RLS por tenant, como toda tabla de negocio
```

**Por qué en `channels` y no como columna de `conversations`:**

- El hilo es un dato **del transporte**, no de la conversación de negocio. Una
  conversación nuestra puede moverse de cuenta (cuando se migre de Zavu a
  Zernio, cuenta por cuenta) y el hilo NO viaja con ella: es de la cuenta.
- La regla de base de datos prohíbe escribir tablas de otro módulo. Si el hilo
  viviera en `conversations`, el camino de entrada de `channels` tendría que
  escribir ahí. Así, cada módulo escribe lo suyo.
- El adaptador **no tiene estado**. Si guardara el hilo en memoria, dos
  procesos crearían dos conversaciones para el mismo cliente.

### 2 · El puerto gana dos campos opcionales, y nada más

```ts
interface OutboundMessage   { …; providerThreadId?: string }
interface NormalizedInbound { …; providerThreadId?: string }
send(…): Promise<{ providerMessageId: string; providerThreadId?: string }>
```

Opcionales: Zavu los ignora y no cambia una línea. El puerto no se ensucia para
los proveedores que no los necesitan, que era el criterio 5 de #1320.

### 3 · Quién lee y quién escribe

| Momento | Quién | Qué hace |
|---|---|---|
| Entra un mensaje | webhook de la API → contrato de `channels` | `recordarHilo` con el `providerThreadId` que trajo `normalize`. **Último gana**: el proveedor es la fuente de verdad del hilo. |
| Sale un mensaje | worker, antes de `deliverOutbound` | `hiloDe(cuenta, peer)` y lo pone en el mensaje |
| El adaptador tuvo que crear el hilo | worker, después | `recordarHilo` con el que devolvió `send` |

El adaptador nunca toca la base. Recibe el hilo y, si creó uno, lo devuelve.

### 4 · Concurrencia: un candado por destinatario

Dos salientes al mismo contacto sin hilo conocido crearían dos conversaciones
en Zernio. El worker toma

```sql
SELECT pg_advisory_xact_lock(hashtextextended('hilo:' || cuenta || ':' || peer, 0))
```

antes de leer el hilo, y lo suelta al commit, que es después de recordarlo. Es
el patrón que ya usan `audit` y las concesiones de Google. El costo es
serializar los envíos **al mismo destinatario de la misma cuenta**, que ya se
serializan en la práctica.

**Y no es opcional, medido en el spec:** enviar dentro de una conversación
acepta `Idempotency-Key`, pero **crear la conversación no**. El candado es la
única protección contra crear dos.


### 5 · Cuando los dos lados no coinciden

- **Sin hilo conocido y sin plantilla** (el cliente escribió pero se perdió el
  webhook): el adaptador **busca antes de crear** con
  `GET /v1/inbox/conversations/search`. Si la encuentra, la devuelve como hilo
  nuevo y el worker la recuerda. **Ojo:** la ruta está en el spec pero ni
  ZernFlow ni Vocero la usan — ZernFlow reconstruye paginando
  `GET /v1/inbox/conversations?accountId=…` y se queda con la más reciente.
  Verificar que `/search` filtra por participante antes de apoyarse en ella; si
  no, el respaldo es paginar.
- **Tenemos el hilo y Zernio lo borró** (404 en el envío): el adaptador lo
  informa como error clasificado `hilo_vencido`; el worker borra la fila y
  reintenta **una** vez, que cae en el caso anterior. Una sola: si vuelve a
  fallar, es otra cosa y tiene que verse.
- **El webhook trae un hilo distinto al guardado**: gana el del webhook (último
  gana). Es lo que pasa cuando Zernio rehace una conversación.

## Riesgo que esta ADR deja escrito y no resuelve

**`sender.phoneNumber` es nullable en el spec.** Meta está moviendo a
identificadores BSUID y nombres de usuario; un mensaje puede llegar sin
teléfono. Hoy `NormalizedInbound.phone` es obligatorio y todo IAxTi identifica
al contacto por E.164.

Mientras sea así, `peer` es el teléfono y un mensaje sin teléfono **no puede
entrar** — tiene que fallar clasificado y visible, no perderse. Que `peer` pase
a aceptar BSUID es una decisión que toca contactos y deduplicación, y necesita
su propia ADR. Issue aparte.

## Lo que esto habilita para #1321 (un perfil por tenant)

Al crear el perfil de Zernio de un tenant se le pone `externalId = tenant_id`.
Cada webhook trae `profiles[].externalId`, así que el camino de entrada puede
**rechazar un webhook cuyo perfil no sea del tenant de la cuenta destino**.
Eso convierte el aislamiento de «nos acordamos de crear un perfil por cliente»
en una verificación por mensaje que hace el código. Es exactamente lo que #1321
pedía: impuesto por el código y no por la memoria.

## Consecuencias

**A favor**

- El caso normal —el cliente escribió primero— no hace ninguna llamada extra:
  el hilo ya está.
- La única creación de hilo coincide con algo que ya pasa por plantilla y por
  todas nuestras reglas de envío iniciado por el negocio.
- Zavu no se entera de nada.

**En contra**

- Una tabla más, con su RLS, su prueba de aislamiento y su lugar en el
  inventario.
- Un candado por destinatario en el camino de salida. Medir que no se note.
- Mientras convivan los dos proveedores, una conversación nuestra puede tener
  hilo en una cuenta y no en otra. Es correcto, pero hay que saberlo al leer.

## Cómo se verifica

1. Dos workers mandando a la vez al mismo contacto sin hilo: **una** conversación
   en Zernio. Con concurrencia de verdad, no suponiendo.
2. Un entrante recuerda el hilo; el saliente siguiente no crea nada.
3. Un hilo borrado del lado de Zernio se recupera con un reintento y no con dos.
4. Un entrante sin teléfono falla clasificado y queda visible.
5. Zavu: las suites de canales y de salida, sin cambios.
