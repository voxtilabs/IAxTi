import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type IORedis from 'ioredis';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { redisConnection } from '@iaxti/core';
import { receiveInbound, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import { createChannelAccount, registerProvider, resetProviders, setChannelState } from '@iaxti/module-channels';
import { optOut } from '@iaxti/module-crm';
import { createTemplate, type OutboundJobData } from '@iaxti/module-whatsapp';
import { processOutbound } from '../src/outbound';

let pool: Pool;
let redis: IORedis;
let tenantId: string;
let conversationId: string;
let contactId: string;
let accountId: string;
const send = vi.fn(async () => ({ providerMessageId: `wa-${randomUUID()}` }));
const en = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenantId, fn);

/**
 * La tabla a la que se desvía el UPDATE del rechazo. Tiene que NO existir:
 * así el error lo pone Postgres y la transacción queda abortada de verdad,
 * igual que cuando la base no está disponible.
 */
const MESSAGES_INEXISTENTE = 'messages_que_no_existe';

/**
 * Un pool al que se le cae la escritura del rechazo (#910).
 *
 * Antes esto se provocaba creando un trigger `BEFORE UPDATE ON messages` en el
 * esquema COMPARTIDO y borrándolo en un `finally`. El filtro por tenant
 * acotaba el daño, pero si el proceso muere en el medio —Ctrl-C, OOM, el
 * timeout de la suite— el trigger y su función se quedan en la base para
 * siempre, apuntando a un tenant que ya no existe. Nada falla y nadie se
 * entera.
 *
 * Ahora se desvía el TEXTO de la consulta de ESTA conexión, como en #913: el
 * catálogo no se toca y para los otros archivos que corren en paralelo
 * `messages` nunca dejó de existir.
 *
 * Solo el `UPDATE`: el `SELECT … FOR UPDATE` con el que el despacho lee el
 * mensaje tiene que funcionar, o el fallo pasaría ANTES de decidir el rechazo
 * y la prueba dejaría de hablar de lo que dice su nombre.
 */
function poolSinEscrituraDeMensajes(real: Pool): Pool {
  const desviar = (sql: string) =>
    /update\s+messages\b/i.test(sql)
      ? sql.replace(/\bmessages\b/gi, MESSAGES_INEXISTENTE)
      : sql;
  const envolver = (cliente: { query: unknown }) => {
    const consultar = (cliente.query as (...a: unknown[]) => unknown).bind(cliente);
    return new Proxy(cliente, {
      get(destino, prop, receptor) {
        if (prop !== 'query') return Reflect.get(destino, prop, receptor);
        return (...args: unknown[]) => {
          const [texto, ...resto] = args;
          if (typeof texto === 'string') return consultar(desviar(texto), ...resto);
          const config = texto as { text?: unknown } | null;
          if (config && typeof config.text === 'string') {
            return consultar({ ...config, text: desviar(config.text) }, ...resto);
          }
          return consultar(...args);
        };
      },
    });
  };
  return new Proxy(real, {
    get(destino, prop, receptor) {
      if (prop !== 'connect') return Reflect.get(destino, prop, receptor);
      // `connect` tiene DOS formas y hay que honrar las dos: `pool.query()` de
      // `pg` usa la de CALLBACK, y una envoltura que solo devuelva promesa deja
      // cualquier `pool.query` esperando a nadie (la trampa de #913).
      return (cb?: (e: Error | undefined, c?: unknown, release?: unknown) => void) => {
        if (typeof cb === 'function') {
          return (destino.connect as unknown as (f: typeof cb) => unknown)((e, c, release) =>
            cb(e, c ? envolver(c as { query: unknown }) : c, release),
          );
        }
        return destino.connect().then((c) => envolver(c as unknown as { query: unknown }));
      };
    },
  });
}

beforeAll(async () => {
  pool = createPool();
  redis = redisConnection();
  await runMigrations(pool);
  resetProviders();
  for (const kind of ['whatsapp', 'instagram', 'messenger'] as const) {
    registerProvider({ kind, send, verifyWebhook: () => true, normalize: () => [] });
  }
});
beforeEach(async () => {
  send.mockClear();
  const t = await pool.query("INSERT INTO tenants (name, state) VALUES ('outbound-vigencia', 'active') RETURNING id");
  tenantId = t.rows[0].id;
  const account = await en(c => createChannelAccount(c, { tenantId, kind: 'whatsapp', name: 'Prueba' }));
  accountId = account.id;
  await en(c => setChannelState(c, { tenantId, accountId, state: 'active' }));
  const inbound = await en(c => receiveInbound(c, {
    tenantId, channel: 'whatsapp', channelAccountId: accountId, phone: '+56912345678', body: 'Hola',
  }));
  conversationId = inbound.conversation.id;
  contactId = inbound.contact.id;
});
afterAll(async () => { resetProviders(); await redis.quit(); await pool.end(); });

async function job(extra: Partial<OutboundJobData> = {}) {
  const message = await en(c => sendMessage(c, { tenantId, conversationId, authorKind: 'user', body: 'Tu hora' }));
  return { attemptsMade: 0, opts: { attempts: 5 }, data: {
    tenantId, messageId: message.id, channelAccountId: accountId, to: '', initiatedByBusiness: false, ...extra,
  } };
}
async function assertRechazado(j: Awaited<ReturnType<typeof job>>, motivo: RegExp) {
  const res = await processOutbound(pool, redis, j);
  expect(res.failed).toMatch(motivo);
  expect(send).not.toHaveBeenCalled();
  const m = await pool.query('SELECT delivery_status, meta FROM messages WHERE id = $1', [j.data.messageId]);
  expect(m.rows[0].delivery_status).toBe('failed');
  expect(m.rows[0].meta.error).toMatch(motivo);
  const events = await pool.query("SELECT id FROM outbox WHERE tenant_id = $1 AND name = 'message.failed' AND payload->>'messageId' = $2", [tenantId, j.data.messageId]);
  expect(events.rowCount).toBe(1);
}
async function plantilla(j: Awaited<ReturnType<typeof job>>) {
  const t = await en(c => createTemplate(c, { tenantId, name: 'aviso_cita', language: 'es_CL', category: 'utility', body: 'Tu hora' }));
  await pool.query("UPDATE whatsapp_templates SET status = 'approved' WHERE id = $1", [t.id]);
  await pool.query("UPDATE messages SET type = 'plantilla', meta = jsonb_build_object('plantilla', $2::jsonb) WHERE id = $1", [j.data.messageId, JSON.stringify({ id: t.id, name: t.name, language: t.language, category: t.category, valores: [] })]);
  return t;
}

describe('reglas vigentes al consumir la cola (#372)', () => {
  it.each([true, false])('STOP posterior al encolado bloquea el envío (negocio=%s)', async initiatedByBusiness => {
    const j = await job({ initiatedByBusiness, transaccional: true });
    await en(c => optOut(c, { tenantId, contactId, reason: 'el contacto escribió STOP' }));
    await assertRechazado(j, /consentimiento|no recibir/i);
  });
  it.each(['whatsapp', 'instagram', 'messenger'])('la ventana de %s vencida antes de entregar bloquea texto', async channel => {
    const j = await job();
    await pool.query("UPDATE conversations SET channel = $2, last_inbound_at = now() - interval '25 hours' WHERE id = $1", [conversationId, channel]);
    await pool.query('UPDATE channel_accounts SET kind = $2 WHERE id = $1', [accountId, channel]);
    await assertRechazado(j, /24 horas|ventana/);
  });
  it('una cuenta desconectada después de encolar no recibe llamadas', async () => {
    const j = await job();
    await en(c => setChannelState(c, { tenantId, accountId, state: 'disconnected' }));
    await assertRechazado(j, /canal.*activ|canal.*conectad/i);
  });
  it('una respuesta a un contacto importado que escribió sí sale', async () => {
    const j = await job();
    await pool.query("UPDATE contacts SET origin = 'importado', opt_in_at = NULL WHERE id = $1", [contactId]);
    expect((await processOutbound(pool, redis, j)).providerMessageId).toBeTruthy();
  });
  it('sin entrante ni opt-in no sale un mensaje iniciado por el negocio', async () => {
    const j = await job({ initiatedByBusiness: true, transaccional: true });
    await pool.query("UPDATE contacts SET origin = 'importado', opt_in_at = NULL WHERE id = $1", [contactId]);
    await pool.query('UPDATE conversations SET last_inbound_at = NULL WHERE id = $1', [conversationId]);
    await plantilla(j);
    await assertRechazado(j, /consentimiento/);
  });
  it('una plantilla pausada después de encolar no sale', async () => {
    const j = await job();
    const t = await plantilla(j);
    await pool.query("UPDATE whatsapp_templates SET status = 'paused' WHERE id = $1", [t.id]);
    await assertRechazado(j, /plantilla.*aprobad/i);
  });
  it('una plantilla aprobada puede salir fuera de ventana', async () => {
    const j = await job();
    await plantilla(j);
    await pool.query("UPDATE conversations SET last_inbound_at = now() - interval '25 hours' WHERE id = $1", [conversationId]);
    expect((await processOutbound(pool, redis, j)).providerMessageId).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rechaza una plantilla cuyo texto aprobado cambió mientras esperaba', async () => {
    const j = await job();
    const t = await plantilla(j);
    await pool.query("UPDATE whatsapp_templates SET body = 'Otro contenido' WHERE id = $1", [t.id]);
    await assertRechazado(j, /plantilla.*aprobad/i);
  });
  it('no usa una plantilla de otro tenant', async () => {
    const j = await job();
    const t = await plantilla(j);
    const otro = await pool.query("INSERT INTO tenants (name) VALUES ('otro') RETURNING id");
    await pool.query('UPDATE whatsapp_templates SET tenant_id = $2 WHERE id = $1', [t.id, otro.rows[0].id]);
    await assertRechazado(j, /plantilla.*aprobad/i);
  });
  it('solo usa la plantilla persistida, nunca metadatos inyectados en el job', async () => {
    const j = await job({ extra: { plantilla: { name: 'no_aprobada' } } });
    await processOutbound(pool, redis, j);
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ extra: expect.anything() }));
  });
  it('funciona con RLS y un tenant no puede entregar el mensaje de otro', async () => {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_outbound_test') THEN
        CREATE ROLE iaxti_outbound_test LOGIN PASSWORD 'iaxti_outbound_test' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
    await pool.query('GRANT USAGE ON SCHEMA public TO iaxti_outbound_test');
    await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_outbound_test');
    await pool.query('GRANT SELECT ON messages, conversations, contacts, contact_identities, tenants, channel_accounts TO iaxti_outbound_test');
    await pool.query('GRANT UPDATE ON messages TO iaxti_outbound_test');
    await pool.query('GRANT INSERT ON outbox TO iaxti_outbound_test');
    const app = createPool(process.env.DATABASE_URL!.replace(/\/\/[^@]+@/, '//iaxti_outbound_test:iaxti_outbound_test@'));
    try {
      expect((await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false });
      const j = await job();
      const ajeno = { ...j, data: { ...j.data, tenantId: randomUUID() } };
      expect((await processOutbound(app, redis, ajeno)).failed).toBe('mensaje inexistente');
      expect(send).not.toHaveBeenCalled();
      expect((await processOutbound(app, redis, j)).providerMessageId).toBeTruthy();
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await app.end(); }
  });
  it('un fallo al persistir el rechazo no se oculta ni confirma el job', async () => {
    const j = await job();
    await en(c => optOut(c, { tenantId, contactId, reason: 'el contacto escribió STOP' }));

    // El contacto dijo STOP, así que el despacho va a rechazar el envío — y al
    // escribir ese rechazo se encuentra con que no puede.
    await expect(
      processOutbound(poolSinEscrituraDeMensajes(pool), redis, j),
    ).rejects.toThrow(MESSAGES_INEXISTENTE);

    // Ni se mandó, ni el job quedó confirmado con un estado que no se guardó:
    // el mensaje sigue en cola, que es lo que hace que el reintento lo tome.
    expect(send).not.toHaveBeenCalled();
    expect((await pool.query('SELECT delivery_status FROM messages WHERE id = $1', [j.data.messageId])).rows[0].delivery_status).toBe('queued');
  });
  it.each(['sent', 'delivered', 'read', 'failed'] as const)('un mensaje %s no vuelve al proveedor', async status => {
    const j = await job();
    await en(c => updateDeliveryStatus(c, { tenantId, messageId: j.data.messageId, status, providerMessageId: 'wa-previo' }));
    await processOutbound(pool, redis, j);
    expect(send).not.toHaveBeenCalled();
    expect((await pool.query('SELECT delivery_status FROM messages WHERE id = $1', [j.data.messageId])).rows[0].delivery_status).toBe(status);
  });
  it('dos consumidores simultáneos entregan una sola vez un mensaje confirmado', async () => {
    const j = await job();
    await Promise.all([processOutbound(pool, redis, j), processOutbound(pool, redis, j)]);
    expect(send).toHaveBeenCalledTimes(1);
    const events = await pool.query("SELECT id FROM outbox WHERE tenant_id = $1 AND name = 'message.sent' AND payload->>'messageId' = $2", [tenantId, j.data.messageId]);
    expect(events.rowCount).toBe(1);
  });
});
