---
name: iaxti-channel-provider
description: Contrato ChannelProvider y adaptador Zavu (WhatsApp, Instagram, Messenger). Usar al tocar channels, whatsapp, webchat, webhooks de mensajería, plantillas o la ventana de 24h.
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

## Reglas del adaptador Zavu (SPEC §12, ADR-0014)

- **Un adaptador, tres canales**: WhatsApp, Instagram y Messenger comparten
  envelope, firma y estados. Se registran como tres `kind` del mismo código.
- **El vocabulario de Zavu no cruza el adaptador.** Sus ids (`senderId`, su
  `messageId`) viven en columnas; el dominio no los conoce. El WAMID de Meta se
  guarda cuando llega, porque el día del proveedor propio (#82) sirve.
- **Webhooks**: firma `X-Zavu-Signature: t=<seg>[,v1][,v2]` sobre el cuerpo
  CRUDO — `v2` cubre `{t}.{body}` y manda; `v1` (cuerpo solo) se acepta para
  senders viejos. Rechazar si `|ahora - t| > 300`. Encolar en `inbound`,
  responder < 1 s, idempotencia por id del proveedor. Zavu reintenta a 1, 5 y
  15 min, 1 h y 4 h; a los 5 intentos marca fallida la entrega.
- **El tipo del evento es la verdad**, no el campo `status`: en Zavu un mensaje
  entrante también queda `delivered`. Los estados salen de `message.sent`,
  `message.delivered`, `message.read` y `message.failed`.
- `conversationId` llega `null` en el primer mensaje de un hilo nuevo: se
  resuelve por `conversation.new` o consultando el mensaje.
- El `referral` de click-to-WhatsApp llega SOLO en el primer mensaje del hilo:
  se persiste al llegar o se pierde.
- **Zavu sin lógica de negocio**: sus Agents, Functions, Flows, Memory y
  Broadcasts NO se usan. Conversaciones y contactos viven en nuestro Postgres.
- Salientes por cola `outbound`: rate limit por número, reintento exponencial,
  `failed` con causa legible en la bandeja.
- Ventana de 24 h desde `last_inbound_at`: fuera de ventana SOLO plantilla
  `approved`; la API rechaza aunque la UI falle. Horario de silencio y
  consentimiento aplican a todo envío iniciado por el negocio.
- Adjuntos: la URL del proveedor es firmada y de vida corta → se descargan al
  llegar y van a R2 por tenant.
- Calidad del número en `red` → pausa automática de envíos del negocio +
  aviso al ADMIN; se reactiva a mano.

## Herramientas

Skills oficiales de Zavu instalables con `npx skills add zavudev/zavu-skills`.
Usar los de transporte: `send-message`, `conversations`, `channel-setup`,
`whatsapp-templates`, `webhook-setup`, `contacts-management`. **NO** usar
`ai-agent`, `functions`, `memory` ni `broadcast-campaign`: esa capa es nuestra.

En staging, número de prueba: nunca un número real fuera de producción.

## Migración futura

Ser proveedor propio ante Meta = cambiar el adaptador, no el módulo. Es la
Fase 7: spike con gatillo numérico (#82), adaptadores Graph directos (#158) y
plan de salida ensayado (#159).
