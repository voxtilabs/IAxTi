# ADR 0032 · Un proveedor por CUENTA, y con eso la puerta a Zernio

**Estado:** propuesta · 2026-11-09 · revisa parcialmente la
[ADR-0014](0014-zavu-como-capa-de-canales.md)

## Contexto

La ADR-0014 eligió Zavu por una razón concreta: **el diferenciador comercial es
omnicanal**, y Kapso no tenía Instagram ni Messenger. Esa razón sigue siendo
válida; lo que cambió es que ahora hay otro proveedor que la cumple igual o
mejor, y que aparecieron dos necesidades que Zavu no cubre.

### Lo medido sobre Zernio

Son cifras propias, de la evaluación de canales, no del material del proveedor:

| 10 cuentas · 300k msjs/mes | 50 cuentas |
|---|---|
| Zernio ≈ $77 · Zavu $83 · Kapso $299 | Zernio ≈ $168 · Zavu $363 · Kapso $299 |

- **El precio NO es el argumento a la escala de hoy** —seis dólares al mes—,
  pero sí lo es si crecen las conexiones, que es la intención declarada del
  dueño: a 50 cuentas son $168 contra $363. Zernio incluye 2 cuentas y después
  cobra $6/$3/$1 por cuenta según banda; Zavu no tiene esa escalera.
- **Llamadas de WhatsApp enrutadas a un agente de voz**, que Zavu no tiene. Esto
  sí es un argumento: es exactamente el producto de voz que VoxTi Labs está por
  vender. Hoy la plataforma de voz y el canal de WhatsApp viven separados.
- **Bandeja unificada real** (Instagram, Facebook, Telegram, X), que es el
  omnicanal por el que se eligió Zavu.
- Como Tech Provider **no tiene línea de crédito**: Meta le factura directo al
  cliente. O sea que Zernio es casi el proveedor propio de la ADR-0014 sin
  construirlo; el delta real es control y propiedad de los datos, no precio.
- **ZernFlow es open source** y ya tenemos fork y un PR upstream. Es el único de
  los tres que se puede leer por dentro.

### La premisa de la ADR-0014 está en duda, y eso cambia el peso de todo esto

La ADR-0014 eligió Zavu por una razón explícita: **«el diferenciador comercial
es omnicanal»**, y Kapso no tenía Instagram ni Messenger.

**El dueño sostiene que Zavu no entrega Instagram** — «solo promete», dicho el
09-11. Si es así, la razón por la que se eligió Zavu sobre Kapso nunca se
cumplió, y esta ADR deja de ser «abrir una puerta por si acaso» para pasar a
ser el camino de salida.

Lo que se puede verificar desde el repo **no lo decide, y conviene decirlo**:
el código registra `whatsapp`, `instagram` y `messenger` con el mismo adaptador
(`apps/api/src/main.ts:73`), y la base local tiene cuentas y conversaciones de
los tres. Pero esas filas son fixtures de las pruebas: demuestran que el
producto sabe hablar Instagram, no que el proveedor lo entregue.

**Y ese es justo el problema:** tenemos código, pruebas y una ADR que dan por
hecho una capacidad que el dueño dice que no existe. Es el defecto que más se
repite en este repo —algo declarado en un lado y no aplicado en el otro— con
la diferencia de que acá lo no aplicado está del lado del proveedor.

Lo que lo confirmaría, y hay que hacerlo antes de decidir la migración
completa: **conectar una cuenta de Instagram real por Zavu y mandar y recibir
un mensaje.** Es el patrón que el repo ya exige para los proveedores — se mide
por el puerto del producto, no por la documentación del vendedor (#870).

### Los dos defectos que ya pagamos en producción

No son teóricos: ocurrieron.

1. **Una cuenta por plataforma por perfil, y conectar otra en un slot ocupado la
   REEMPLAZA** — borra inbox, DMs y analytics. `inmobiliariasegura.cl` pisó a
   `agenciapalena`. En un CRM multi-tenant eso es **perder los datos de un
   cliente por el click de otro**.
2. **60 req/min y caché de minutos**: no se puede leer a través de él. Hace falta
   almacén propio sincronizado por webhook más barrido — que es lo que ZernFlow
   terminó haciendo con `comment_logs`.

## El problema que esta ADR resuelve

**Hoy no se puede probar Zernio sin apagar Zavu.** El registro de adaptadores
tiene la clave por CANAL, no por proveedor:

```ts
const providers = new Map<ChannelKind, ChannelProvider>();
export function registerProvider(provider: ChannelProvider): void {
  if (providers.has(provider.kind)) throw new Error(`Ya hay un adaptador para "${provider.kind}".`);
```

Y los siete llamadores resuelven con `getProvider(kind)`. O sea que elegir
proveedor es una decisión **del despliegue entero**: o todos los clientes en
Zavu, o todos en Zernio. Para un producto con clientes reales encima, eso no es
una migración, es un salto al vacío.

## Decisión

**El proveedor pasa a ser un atributo de la CUENTA de canal, no del despliegue.**

1. `channel_accounts` gana una columna `provider` (texto, `NOT NULL`, por
   omisión `'zavu'`). Migración aditiva: todo lo que existe hoy queda igual.
2. El registro se indexa por `(provider, kind)`. `registerProvider` deja de ser
   un cerrojo global y pasa a rechazar solo el duplicado exacto.
3. `getProvider` resuelve **desde la cuenta**. En cinco de los siete llamadores
   la cuenta ya está a mano (`cuenta.kind`, `account.kind`): es pasar lo que ya
   tienen.
4. Los dos llamadores que hoy solo tienen el canal —`transportes-aviso.ts` y el
   respaldo de `webhooks.controller.ts`— conservan una resolución por canal, y
   esa excepción queda escrita acá: resuelven al proveedor **por omisión del
   despliegue**, no a «el único que hay».

Con eso, migrar es mover una cuenta a la vez y poder volver atrás con un UPDATE.

**Zernio entra como un adaptador más, no como un reemplazo.** La primera cuenta
que vaya ahí es una nueva, para el caso que Zavu no cubre: llamada de WhatsApp
hacia un agente de voz.

## Lo que esta ADR NO decide

- **No migra a Zernio.** Decide que se pueda, cuenta por cuenta.
- **No deroga la ADR-0014.** Zavu sigue siendo el proveedor por omisión y el que
  atiende los números actuales.
- **No resuelve el defecto del slot que borra datos.** Antes de que una cuenta de
  un cliente real viva en Zernio, hace falta una garantía dura de un perfil por
  tenant. Mientras eso no exista, a Zernio solo van cuentas nuestras.

## Consecuencias

**A favor**

- Se puede probar un proveedor nuevo sin tocar a ningún cliente.
- Volver atrás es un `UPDATE` de una fila, no un despliegue.
- El vocabulario de Meta en la base —que la ADR-0005 dejó a propósito y la 0014
  conservó— por fin paga: es lo que permite que dos adaptadores convivan.

**En contra**

- Una dimensión más en los datos: cada cuenta dice su proveedor, y una cuenta mal
  marcada manda por el lugar equivocado. Lo tapa un `CHECK` contra la lista de
  proveedores registrados y una guarda que falla al arrancar si una cuenta
  declara uno que nadie registró.
- Dos adaptadores vivos es más superficie de prueba. El puerto es chico —cuatro
  métodos— pero las plantillas y la firma del webhook difieren por proveedor.

## Cómo se verifica

- Una cuenta en Zavu y otra en Zernio, en el mismo despliegue, mandando y
  recibiendo cada una por su camino.
- Que una cuenta con un proveedor inexistente **no arranque**, en vez de caer al
  que esté registrado.
- Que el respaldo por canal de los dos llamadores sin cuenta resuelva al
  proveedor por omisión declarado, y que eso esté en una prueba.
