import type { Consumer, EventEnvelope } from '@iaxti/core';

// Realtime por BROADCAST desde el servidor (SPEC §40, #37): los eventos de la
// bandeja se reenvían al canal privado `tenant:<id>:bandeja` de Supabase
// Realtime. Nunca postgres_changes. El payload es mínimo (ids): el cliente
// refresca por la API con sus permisos; por el socket no viaja contenido.

export const BANDEJA_EVENTS = [
  'conversation.created',
  'conversation.assigned',
  'conversation.state_changed',
  'message.received',
  'message.sent',
  'message.failed',
] as const;

export function bandejaTopic(tenantId: string): string {
  return `tenant:${tenantId}:bandeja`;
}

export interface RealtimeEnv {
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

export async function broadcastBandeja(
  event: EventEnvelope,
  env: RealtimeEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload = event.payload as Record<string, unknown>;
  const res = await fetchImpl(`${env.supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      apikey: env.serviceRoleKey!,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          topic: bandejaTopic(event.tenantId),
          event: event.name,
          private: true,
          payload: {
            conversationId: payload.conversationId ?? null,
            messageId: payload.messageId ?? null,
          },
        },
      ],
    }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) {
    // Lanza para que el despachador reintente (idempotente por consumidor).
    throw new Error(`broadcast bandeja falló: HTTP ${res.status}`);
  }
}

/** Consumidores del outbox; vacío si el ambiente no tiene Supabase. */
export function realtimeConsumers(env: RealtimeEnv = {
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
}): Consumer[] {
  if (!env.supabaseUrl || !env.serviceRoleKey) {
    console.log('workers: sin SUPABASE_URL/SERVICE_ROLE_KEY; realtime de bandeja apagado');
    return [];
  }
  return BANDEJA_EVENTS.map((name) => ({
    name: `realtime.bandeja.${name}`,
    moduleId: 'conversations',
    event: name,
    handler: (event) => broadcastBandeja(event, env),
  }));
}
