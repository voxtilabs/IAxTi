import type IORedis from 'ioredis';
import { getProvider } from '@iaxti/module-channels';
import type { ChannelAccountRef } from '@iaxti/module-channels';

// Salida de WhatsApp (#43): la cola `outbound` con rate limit POR NÚMERO y
// causas de fallo legibles — un "failed" sin explicación mata la confianza.

/** Errores de la Cloud API traducidos a voz Pulso (los que importan). */
export const CAUSAS_META: Record<number, string> = {
  131026: 'El número no tiene WhatsApp.',
  131047: 'Pasaron más de 24 horas desde su último mensaje: solo salen plantillas aprobadas.',
  131048: 'WhatsApp pausó los envíos de este número por límite de spam.',
  131049: 'Meta descartó el mensaje para proteger la experiencia del cliente.',
  100: 'El mensaje no pasó la validación de WhatsApp.',
  368: 'La cuenta de WhatsApp está temporalmente bloqueada por políticas.',
};

export function causaLegible(codigo?: number, fallback?: string): string {
  return (codigo && CAUSAS_META[codigo]) || fallback || 'WhatsApp no aceptó el envío. Reintenta en unos minutos.';
}

export class RateLimitedError extends Error {
  constructor(public readonly phoneNumberId: string) {
    super('Rate limit del número alcanzado; se reintenta solo.');
  }
}

/**
 * Cupo por número y por segundo (token bucket simple en Redis). Meta admite
 * ráfagas mucho mayores; partimos conservadores y configurable por env.
 */
export async function checkNumberRateLimit(
  redis: IORedis,
  phoneNumberId: string,
  maxPorSegundo = Number(process.env.WHATSAPP_MSGS_PER_SECOND ?? 10),
): Promise<void> {
  const bucket = Math.floor(Date.now() / 1000);
  const key = `wa:rate:${phoneNumberId}:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 2);
  if (n > maxPorSegundo) throw new RateLimitedError(phoneNumberId);
}

export interface OutboundJobData {
  moduleId?: 'whatsapp';
  tenantId: string;
  messageId: string;
  channelAccountId: string;
  to: string;
  body?: string;
  type?: string;
  /** true en plantillas/campañas: respeta el horario de silencio (SPEC §8). */
  initiatedByBusiness?: boolean;
  requestId?: string;
}

/**
 * Entrega un saliente por el adaptador del canal. Lanza para que BullMQ
 * reintente (backoff exponencial ya configurado en la cola); el worker
 * decide cuándo el fallo es definitivo y lo marca con causa legible.
 */
export async function deliverOutbound(
  account: ChannelAccountRef,
  data: OutboundJobData,
  redis: IORedis,
): Promise<{ providerMessageId: string }> {
  const provider = getProvider(account.kind);
  if (!provider) throw new Error(`No hay adaptador para el canal ${account.kind}.`);
  const phoneNumberId = (account.config.phoneNumberId as string) ?? account.id;
  await checkNumberRateLimit(redis, phoneNumberId);
  return provider.send(account, { to: data.to, type: data.type ?? 'texto', body: data.body });
}
