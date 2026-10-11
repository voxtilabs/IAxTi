// E2E de la bandeja (#36): el simulador encola en la cola REAL `inbound` de
// BullMQ y el worker real procesa — el mismo camino de código que usará el
// canal de WhatsApp en Fase 3. Necesita Postgres y Redis (docker compose up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Queue, QueueEvents } from 'bullmq';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry, createModuleWorker, createQueue, redisConnection } from '@iaxti/core';
import { changeConversationState } from '@iaxti/module-conversations';
import { processInbound, type InboundJob, type InboundOutcome } from '../src/inbound';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let queue: Queue;
let events: QueueEvents;
let worker: ReturnType<typeof createModuleWorker>;
let tenant: string;

async function simular(data: Omit<InboundJob, 'moduleId' | 'tenantId'>): Promise<InboundOutcome> {
  const job = await queue.add('simulado', {
    moduleId: 'conversations',
    tenantId: tenant,
    ...data,
  } satisfies InboundJob);
  return (await job.waitUntilFinished(events, 15_000)) as InboundOutcome;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('e2e-bandeja') RETURNING id");
  tenant = t.rows[0].id;

  const registry = new ModuleRegistry().load();
  queue = createQueue('inbound', redisConnection());
  await queue.obliterate({ force: true }); // sin restos de corridas anteriores
  events = new QueueEvents('inbound', { connection: redisConnection() });
  await events.waitUntilReady();
  worker = createModuleWorker(
    'inbound',
    registry,
    // `as unknown as`, igual que el worker de verdad (main.ts:501): la cola es
    // genérica a propósito (`moduleId?: string`) y el handler conoce su forma.
    // El cast directo no compila y así la prueba usa el mismo camino.
    async (job) => processInbound(admin, job.data as unknown as InboundJob),
    redisConnection(),
  );
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await events?.close();
  await queue?.close();
  if (tenant) {
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  }
  await admin.end();
});

describe('simulador → cola inbound → worker (e2e)', () => {
  it('un contacto nuevo crea contacto, conversación new y mensaje entrante', async () => {
    const res = await simular({ phone: '+56 9 4444 5555', body: 'Hola, ¿tienen horas?' });
    expect(res.contactCreated).toBe(true);
    expect(res.conversationCreated).toBe(true);
    expect(res.optedOut).toBe(false);

    const conv = await admin.query('SELECT state, last_inbound_at FROM conversations WHERE id = $1', [
      res.conversationId,
    ]);
    expect(conv.rows[0].state).toBe('new');
    expect(conv.rows[0].last_inbound_at).not.toBeNull();
    const msg = await admin.query('SELECT direction, body FROM messages WHERE id = $1', [res.messageId]);
    expect(msg.rows[0]).toEqual({ direction: 'in', body: 'Hola, ¿tienen horas?' });
  });

  it('el contacto existente cae en la misma conversación', async () => {
    const res = await simular({ phone: '+56944445555', body: '¿Sigue disponible?' });
    expect(res.contactCreated).toBe(false);
    expect(res.conversationCreated).toBe(false);
    const n = await admin.query(
      'SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1',
      [tenant],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('la respuesta del cliente reabre una conversación resuelta', async () => {
    const conv = await admin.query('SELECT id FROM conversations WHERE tenant_id = $1 LIMIT 1', [tenant]);
    await withTenant(admin, tenant, (c) =>
      changeConversationState(c, {
        tenantId: tenant,
        conversationId: conv.rows[0].id,
        state: 'resolved',
        actor: 'e2e',
      }),
    );
    const res = await simular({ phone: '+56944445555', body: 'me quedó una duda' });
    expect(res.reopened).toBe(true);
    expect(res.conversationId).toBe(conv.rows[0].id);
    const estado = await admin.query('SELECT state FROM conversations WHERE id = $1', [conv.rows[0].id]);
    expect(estado.rows[0].state).toBe('new'); // sin dueño: vuelve a la cola
  });

  it('"BASTA" marca el opt-out por el mismo camino', async () => {
    const res = await simular({ phone: '+56 9 6666 7777', body: 'BASTA' });
    expect(res.optedOut).toBe(true);
    const contacto = await admin.query('SELECT opted_out_at FROM contacts WHERE id = $1', [res.contactId]);
    expect(contacto.rows[0].opted_out_at).not.toBeNull();
  });
}, 30_000);

/**
 * Cuando un adjunto NO se puede guardar, se dice (#809).
 *
 * El camino era `if (account && apiKey && storage)` y nada más: con cualquiera
 * de las tres en falso se caía por fuera del `if` sin una línea de log —el
 * `catch` solo salta si algo LANZA—, el mensaje se guardaba con la URL firmada
 * y de vida corta del proveedor, y esa URL vence. El adjunto se perdía para
 * siempre y el único rastro era un enlace muerto.
 *
 * El caso caro es `!storage`: cuatro variables de R2 que no estaban nombradas
 * en ningún runbook, que el compose interpola sin `:?` —así que sin valor
 * quedan en cadena vacía y nada falla al arrancar— y que al faltar se llevan
 * los adjuntos de TODOS los negocios a la vez.
 *
 * Llama a `processInbound` directo y no por la cola, a diferencia del resto
 * del archivo: lo que se mide es lo que el worker DICE, y por la cola un
 * error se convierte en reintentos con espera —el job no termina, la prueba
 * se cae por tiempo y el motivo real queda escondido justo en el
 * `console.error` que esta prueba está interceptando.
 */
describe('el adjunto que no se guarda lo dice en voz alta (#809)', () => {
  const guardados = { ...process.env };
  let gritos: string[] = [];
  const errorReal = console.error;
  let cuenta: string;
  const INEXISTENTE = '00000000-0000-0000-0000-0000000000a9';

  beforeAll(async () => {
    console.error = (...args: unknown[]) => {
      gritos.push(args.map(String).join(' '));
    };
    // Una cuenta de canal de verdad, con su credencial presente: así la única
    // pieza que puede faltar es R2, que es el caso que importa.
    const r = await admin.query(
      `INSERT INTO channel_accounts (tenant_id, kind, name, credential_ref)
       VALUES ($1, 'whatsapp', 'Prueba de adjuntos', 'LLAVE_DE_PRUEBA_809') RETURNING id`,
      [tenant],
    );
    cuenta = r.rows[0].id;
    process.env.LLAVE_DE_PRUEBA_809 = 'no-importa-el-valor';
  });

  afterAll(async () => {
    console.error = errorReal;
    process.env = guardados;
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  });

  /**
   * Un teléfono distinto por caso, y es a propósito: dos mensajes del mismo
   * contacto por cuentas de canal distintas MUDAN el emisor del hilo, y eso
   * escribe en `audit_log` —que es append-only por trigger— así que la
   * limpieza del archivo no podía borrar el tenant después. Conversación
   * nueva en cada caso: ninguna mutación que auditar.
   */
  async function conAdjunto(channelAccountId: string, phone: string): Promise<void> {
    gritos = [];
    await processInbound(admin, {
      moduleId: 'conversations',
      tenantId: tenant,
      phone,
      channel: 'whatsapp',
      channelAccountId,
      type: 'imagen',
      body: 'mira esto',
      attachments: [
        { url: 'https://proveedor.local/firmada-y-vence.jpg', filename: 'boleta.jpg' },
      ],
    } as unknown as InboundJob);
  }

  it('sin R2 no se guarda, y el log dice que se va a perder y cuáles variables faltan', async () => {
    for (const v of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_ADJUNTOS']) {
      delete process.env[v];
    }
    await conAdjunto(cuenta, '+56955550801');
    const aviso = gritos.find((g) => g.includes('NO se guardaron'));
    expect(aviso, `no se avisó nada. Lo que se registró:\n${gritos.join('\n')}`).toBeTruthy();
    expect(aviso).toContain('1 adjunto');
    expect(aviso).toContain(tenant);
    expect(aviso).toContain('se van a perder');
    expect(aviso).toContain('R2_BUCKET_ADJUNTOS');
  });

  it('con R2 puesto, una cuenta que no existe se nombra como lo que es', async () => {
    process.env.R2_ENDPOINT = 'https://cuenta.r2.cloudflarestorage.com';
    process.env.R2_ACCESS_KEY_ID = 'LLAVE_DE_PRUEBA';
    process.env.R2_SECRET_ACCESS_KEY = 'SECRETO_DE_PRUEBA';
    process.env.R2_BUCKET_ADJUNTOS = 'adjuntos-prueba';
    await conAdjunto(INEXISTENTE, '+56955550802');
    const aviso = gritos.find((g) => g.includes('NO se guardaron'));
    expect(aviso, `no se avisó nada. Lo que se registró:\n${gritos.join('\n')}`).toBeTruthy();
    // La causa importa: una cuenta que no existe se arregla en otro lugar que
    // R2 sin configurar, y antes las tres se veían igual — o sea, no se veían.
    expect(aviso).toContain('no existe');
    expect(aviso).not.toContain('R2_BUCKET_ADJUNTOS');
  });
});
