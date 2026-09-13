---
name: iaxti-channel-provider
description: Contrato ChannelProvider y adaptador Kapso/WhatsApp. Usar al tocar channels, whatsapp, webchat, webhooks de mensajería, plantillas o la ventana de 24h.
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

## Reglas del adaptador Kapso (SPEC §12, ADR-0005)

- Vocabulario de la Cloud API de Meta: `phone_number_id`, `waba_id`, ids de
  mensaje, plantillas, ventana de 24 h. Esos ids van en NUESTRA base.
- Webhooks en modo "Meta webhooks" (payload exacto de Meta): verificar firma
  HMAC sobre el raw body (timing-safe), encolar en `inbound`, responder < 1 s,
  idempotencia por id del proveedor. Kapso reintenta a los 10 y 40 s.
- Kapso sin lógica de negocio: sus flows, agentes y base gestionada NO se
  usan. Conversaciones y contactos viven en nuestro Postgres.
- Salientes por cola `outbound`: rate limit por número, reintento exponencial,
  `failed` con causa legible en la bandeja.
- Ventana de 24 h desde `last_inbound_at`: fuera de ventana SOLO plantilla
  `approved`; la API rechaza aunque la UI falle. Horario de silencio y
  consentimiento aplican a todo envío iniciado por el negocio.
- Adjuntos de WhatsApp se descargan al llegar (Meta los expira) → R2 por
  tenant.
- Calidad del número en `red` → pausa automática de envíos del negocio +
  aviso al ADMIN; se reactiva a mano.

## Herramientas

Skills oficiales de Kapso instalables con `npx skills add gokapso/agent-skills`
(usar `integrate-whatsapp` y `observe-whatsapp`; NO `automate-whatsapp`).
Sandbox de Kapso para staging: nunca un número real fuera de prod.

## Migración futura

Ser Tech Provider = cambiar el adaptador (base URL, auth, embedded signup
propio), no el módulo. Camino incremental documentado en el issue #82.
