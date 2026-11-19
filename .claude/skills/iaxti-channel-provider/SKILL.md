---
name: iaxti-channel-provider
description: Contrato ChannelProvider y adaptador Zernio (WhatsApp). Usar al tocar channels, whatsapp, webchat, webhooks de mensajería, plantillas o la ventana de 24h.
---

# Canales y el puerto ChannelProvider

La bandeja y la IA no saben de dónde viene un mensaje. Todo canal implementa:

```ts
interface ChannelProvider {
  kind: 'whatsapp' | 'webchat' | 'instagram' | 'messenger';
  send(msg: OutboundMessage): Promise<ProviderMessageId>;
  verifyWebhook(req): boolean;
  normalize(payload): InboundMessage[];
}
```

## Reglas del adaptador Zernio (SPEC §12, ADR-0032/0033, épica #1338)

- **Un proveedor por cuenta**: la cuenta de canal declara `provider` y el
  registro resuelve por el par `(proveedor, canal)`. El por omisión es
  `zernio` (migración 0010 de channels). Las cuentas viejas de Zavu quedaron
  desconectadas con su etiqueta histórica y resuelven a «nadie» (#1339).
- **El vocabulario de Zernio no cruza el adaptador.** Sus ids —el `zernio:<id>`
  del emisor, el id de su cuenta y de su perfil— viven en columnas y en el
  `config` de la cuenta; el dominio no los conoce.
- **Webhooks**: firma `X-Zernio-Signature` — HMAC-SHA256 en hex, sin prefijo,
  del cuerpo CRUDO byte a byte; comparación timing-safe. Sin timestamp: la
  protección contra repetición es la deduplicación por id de mensaje. NO se
  acepta `X-Late-Signature` (Zernio se llamaba Late; ver `zernio-base.ts`).
- **El evento es de ESTA cuenta o no es**: la firma prueba que viene de
  Zernio; `eventoDeZernioEsDeLaCuenta` comprueba en cada entrega que el
  perfil y la cuenta del sobre son los de la cuenta que recibe (#1321). Un
  evento ajeno con firma buena es un webhook mal atado y se anota aparte.
- **Hilos, no destinatarios (ADR-0033)**: Zernio manda por conversación. El
  `conversationId` del proveedor se aprende en cada mensaje entrante
  (`recordarHilo`) y el worker lo pasa al adaptador al enviar; si un envío
  tuvo que CREAR un hilo, el adaptador lo devuelve y se recuerda.
- **Plantillas**: Zernio todavía no las publica (grupo `publishing`, #1338);
  la sincronización y el envío por plantilla esperan por ese grupo.
- **Estados de entrega y calidad**: Zernio todavía no los publica. El freno
  por calidad roja (`applyQualityUpdate`) y el consumidor de estados quedan
  enchufados; la rama se agrega cuando exista el evento.
- **Zernio sin lógica de negocio**: conversaciones, contactos, plantillas y
  todo lo que decide viven en nuestro Postgres.
- Salientes por cola `outbound`: rate limit por número, reintento
  exponencial, `failed` con causa legible en la bandeja.
- Ventana de 24 h desde `last_inbound_at`: fuera de ventana SOLO plantilla
  `approved`; la API rechaza aunque la UI falle. Horario de silencio y
  consentimiento aplican a todo envío iniciado por el negocio.
- Adjuntos: la URL del proveedor es firmada y de vida corta → se descargan al
  llegar y van a R2 por tenant; la llave solo viaja al dominio de Zernio
  (`llevaCredencial`, #1335).
- Calidad del número en `red` → pausa automática de envíos del negocio +
  aviso al ADMIN; se reactiva a mano.

## Herramientas

El alta de un número es el Embedded Signup de Zernio: el enlace lo arma
`enlaceParaConectar` y el alta completa corre por
`scripts/conectar-zernio.mjs` (perfil por tenant, llave del negocio
restringida a su perfil, secreto del webhook por referencia).

En staging, número real de VoxTi — decisión deliberada (#593), con el
riesgo aceptado anotado en `.claude/rules/seguridad.md`.

## Migración futura

Ser proveedor propio ante Meta = cambiar el adaptador, no el módulo. Es la
Fase 7: spike con gatillo numérico (#82), adaptadores Graph directos (#158) y
plan de salida ensayado (#159). La historia de cómo se llegó acá —la capa de
Zavu, su retiro y por qué— está en la ADR-0014 y la ADR-0032.
