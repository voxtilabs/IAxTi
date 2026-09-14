import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelProvider, NormalizedInbound } from '../domain/port';

// El PRIMER adaptador del puerto (#41): el simulador de Fase 2, ahora por el
// mismo camino que usará Kapso (#42). Firma HMAC-SHA256 del cuerpo crudo en
// X-Iaxti-Signature — el mismo esquema que Meta usa en X-Hub-Signature-256.

export function firmarWebhook(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

interface PayloadSimulado {
  messages?: Array<{
    id?: string;
    phone?: string;
    body?: string;
    type?: string;
    timestamp?: string;
  }>;
}

export const simuladorProvider: ChannelProvider = {
  kind: 'simulador',

  // El simulador "entrega" al instante: no hay red de por medio.
  async send(_account, message) {
    return { providerMessageId: `sim-out-${createHmac('sha256', 'sim').update(JSON.stringify(message)).digest('hex').slice(0, 16)}` };
  },

  verifyWebhook(headers, rawBody, secret) {
    const header = headers['x-iaxti-signature'];
    const firma = Array.isArray(header) ? header[0] : header;
    if (!firma || !secret) return false;
    const esperada = firmarWebhook(rawBody, secret);
    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    return a.length === b.length && timingSafeEqual(a, b);
  },

  normalize(payload) {
    const cuerpo = payload as PayloadSimulado;
    const out: NormalizedInbound[] = [];
    for (const m of cuerpo.messages ?? []) {
      if (!m.phone || !m.id) continue; // sin teléfono o sin id no hay idempotencia
      out.push({
        phone: m.phone,
        type: m.type ?? 'texto',
        body: m.body,
        providerMessageId: m.id,
        timestamp: m.timestamp,
      });
    }
    return out;
  },
};
