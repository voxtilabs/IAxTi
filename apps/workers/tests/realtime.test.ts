import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@iaxti/core';
import { BANDEJA_EVENTS, bandejaTopic, broadcastBandeja, realtimeConsumers } from '../src/realtime';

const evento: EventEnvelope = {
  id: 1,
  name: 'message.received',
  tenantId: 'abc-123',
  payload: { conversationId: 'c1', messageId: 'm1', contactId: 'secreto' },
  actor: 'system',
  requestId: 'r1',
  version: 1,
  occurredAt: new Date(),
};

describe('realtime de bandeja (broadcast, SPEC §40)', () => {
  it('sin Supabase configurado no registra consumidores', () => {
    expect(realtimeConsumers({})).toEqual([]);
  });

  it('con Supabase registra un consumidor idempotente por evento de bandeja', () => {
    const consumers = realtimeConsumers({ supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'srk' });
    expect(consumers.map((c) => c.event)).toEqual([...BANDEJA_EVENTS]);
    expect(new Set(consumers.map((c) => c.name)).size).toBe(BANDEJA_EVENTS.length);
    expect(consumers.every((c) => c.moduleId === 'conversations')).toBe(true);
  });

  it('publica al canal privado del tenant con payload mínimo (solo ids)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    await broadcastBandeja(evento, { supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'srk' }, fetchMock);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/realtime/v1/api/broadcast');
    expect(init.headers.apikey).toBe('srk');
    const body = JSON.parse(init.body);
    expect(body.messages[0].topic).toBe(bandejaTopic('abc-123'));
    expect(body.messages[0].private).toBe(true);
    expect(body.messages[0].event).toBe('message.received');
    // Por el socket no viaja contenido: el cliente refresca por la API.
    expect(body.messages[0].payload).toEqual({ conversationId: 'c1', messageId: 'm1' });
  });

  it('un HTTP no-2xx lanza para que el despachador reintente', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      broadcastBandeja(evento, { supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'srk' }, fetchMock),
    ).rejects.toThrow(/HTTP 500/);
  });
});
