import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { DEFINICIONES, METRICS, montoDelCosto } from '../domain/metrics';
import { analyticsConsumers, bump, sweepResponseSamples } from '../application/aggregate';
import { getDashboard } from '../application/dashboard';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const vendedora = randomUUID();

async function emitir(name: string, payload: Record<string, unknown>, actor = 'system') {
  const client = await admin.connect();
  try {
    const consumer = analyticsConsumers().find((c) => c.event === name)!;
    await consumer.handler(
      {
        id: Math.floor(Math.random() * 1e9),
        name,
        tenantId: tenant,
        payload,
        actor,
        requestId: null,
        version: 1,
        occurredAt: new Date(),
      } as never,
      client,
    );
  } finally {
    client.release();
  }
}

function dashboard(ownerId?: string | null) {
  const hoy = new Date();
  const hace7 = new Date(Date.now() - 7 * 86_400_000);
  return withTenant(admin, tenant, (c) =>
    getDashboard(c, { tenantId: tenant, from: hace7, to: hoy, ownerId: ownerId ?? null }),
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('analytics-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['daily_metrics', 'response_samples', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('definiciones (#66)', () => {
  it('TODO número tiene su definición — sin métricas inventadas', () => {
    for (const metric of METRICS) {
      expect(DEFINICIONES[metric], metric).toBeTruthy();
    }
    expect(DEFINICIONES.primera_respuesta).toContain('percentil 90');
    expect(DEFINICIONES.citas_agendadas).toContain('cuando el módulo');
  });
});

describe('agregación por evento (#66)', () => {
  it('los eventos van sumando contadores por día y tenant', async () => {
    await emitir('conversation.created', { conversationId: randomUUID() });
    await emitir('conversation.created', { conversationId: randomUUID() });
    await emitir('conversation.state_changed', { conversationId: randomUUID(), to: 'resolved' }, vendedora);
    await emitir('deal.created', { dealId: randomUUID() });
    await emitir('deal.won', { dealId: randomUUID(), valueClp: 150000 });
    await emitir('deal.lost', { dealId: randomUUID(), reason: 'precio' });
    await emitir('agent.executed', { executionId: randomUUID(), task: 'sugerir', costUsd: 0.002 });

    const d = await dashboard();
    expect(d.metrics.conversaciones_nuevas).toBe(2);
    expect(d.metrics.resueltas).toBe(1);
    expect(d.metrics.oportunidades_creadas).toBe(1);
    expect(d.metrics.ganadas).toBe(1);
    expect(d.metrics.valor_ganado_clp).toBe(150000);
    expect(d.metrics.ia_ejecuciones).toBe(1);
    expect(d.metrics.ia_costo_usd).toBeCloseTo(0.002);
    expect(d.tasaCierre).toBe(0.5); // 1 ganada / 2 cerradas
    expect(d.porDia.length).toBe(1);
    expect(d.porDia[0].conversaciones).toBe(2);
  });

  it('la vista "por usuario": resueltas de la vendedora quedan a su nombre', async () => {
    const propio = await dashboard(vendedora);
    expect(propio.metrics.resueltas).toBe(1);
    expect(propio.metrics.conversaciones_nuevas).toBe(0); // esas fueron del sistema
  });

  it('los módulos apagados quedan en CERO con su definición, jamás adivinados', async () => {
    const d = await dashboard();
    expect(d.metrics.citas_agendadas).toBe(0);
    expect(d.metrics.pagos_recibidos_clp).toBe(0);
  });

  it('bump acumula sobre la MISMA fila (upsert por día/métrica/dueño)', async () => {
    await withTenant(admin, tenant, (c) =>
      bump(c, { tenantId: tenant, metric: 'mensajes_enviados', value: 3 }),
    );
    await withTenant(admin, tenant, (c) =>
      bump(c, { tenantId: tenant, metric: 'mensajes_enviados', value: 2 }),
    );
    const filas = await admin.query(
      `SELECT count(*)::int AS n, SUM(value)::int AS total FROM daily_metrics
        WHERE tenant_id = $1 AND metric = 'mensajes_enviados'`,
      [tenant],
    );
    expect(filas.rows[0]).toEqual({ n: 1, total: 5 });
  });
});

describe('primera respuesta y "sin responder ahora" (#66)', () => {
  it('el barrido muestrea UNA vez por conversación y los percentiles salen', async () => {
    // Tres conversaciones respondidas (10, 60 y 600 segundos) y una sin responder.
    const contacto = await admin.query(
      `INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, '+56933330001', 'whatsapp') RETURNING id`,
      [tenant],
    );
    for (const seg of [10, 60, 600]) {
      await admin.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel, state, created_at, first_response_at, last_inbound_at, last_message_at, owner_id)
         VALUES ($1, $2, 'whatsapp', 'open', now() - interval '2 hours', now() - interval '2 hours' + make_interval(secs => $3), now() - interval '1 hour', now() - interval '30 minutes', $4)`,
        [tenant, contacto.rows[0].id, seg, vendedora],
      );
    }
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, state, created_at, last_inbound_at, last_message_at)
       VALUES ($1, $2, 'whatsapp', 'new', now() - interval '20 minutes', now() - interval '10 minutes', now() - interval '10 minutes')`,
      [tenant, contacto.rows[0].id],
    );

    const primera = await sweepResponseSamples(admin);
    expect(primera).toBeGreaterThanOrEqual(3);
    const denuevo = await sweepResponseSamples(admin);
    expect(denuevo).toBe(0); // idempotente

    const d = await dashboard();
    expect(d.primeraRespuesta.muestras).toBe(3);
    expect(d.primeraRespuesta.medianaSeg).toBe(60);
    expect(d.primeraRespuesta.p90Seg).toBeGreaterThan(60);
    expect(d.sinResponderAhora).toBe(1); // la nueva sin respuesta
  });
});

describe('el costo del proveedor (issue del costo de Meta)', () => {
  it('un mensaje con costo del proveedor SUMA en costo_meta_usd', async () => {
    // Una conversación y un saliente con el costo tal cual lo guarda el
    // worker de estados: un objeto, no un número.
    const conv = await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, state)
       SELECT $1, id, 'whatsapp', 'open' FROM contacts WHERE tenant_id = $1 LIMIT 1
       RETURNING id`,
      [tenant],
    );
    const msg = await admin.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind, meta)
       VALUES ($1, $2, 'out', 'texto', 'hola', 'user', jsonb_build_object('costo',
         jsonb_build_object('amount', 0.0089, 'currency', 'USD', 'category', 'service')))
       RETURNING id`,
      [tenant, conv.rows[0].id],
    );

    const antes = await admin.query(
      "SELECT COALESCE(SUM(value), 0)::float AS t FROM daily_metrics WHERE tenant_id = $1 AND metric = 'costo_meta_usd'",
      [tenant],
    );
    await emitir('message.sent', { messageId: msg.rows[0].id, conversationId: conv.rows[0].id });
    const despues = await admin.query(
      "SELECT COALESCE(SUM(value), 0)::float AS t FROM daily_metrics WHERE tenant_id = $1 AND metric = 'costo_meta_usd'",
      [tenant],
    );
    // Antes de esto el total no se movía nunca: `Number(meta->>'costo')` era NaN.
    expect(despues.rows[0].t - antes.rows[0].t).toBeCloseTo(0.0089);
  });

  it('saca el monto del objeto, del número pelado, y de nada saca nada', () => {
    // La forma real que guarda `meta.costo`: el objeto del proveedor.
    expect(montoDelCosto({ amount: 0.0089, currency: 'USD', category: 'service' })).toBeCloseTo(0.0089);
    expect(montoDelCosto({ totalUsd: 1.5 })).toBe(1.5);
    expect(montoDelCosto(0.02)).toBe(0.02);

    // Lo que Meta manda en el webhook de estados NO trae monto: categoría y
    // modelo de precio, nada más. Ahí no hay nada que sumar.
    expect(montoDelCosto({ billable: true, pricing_model: 'CBP', category: 'service' })).toBeNull();
    expect(montoDelCosto(null)).toBeNull();
    expect(montoDelCosto('0.05')).toBeNull();

    // Otra moneda no se suma a un total en dólares.
    expect(montoDelCosto({ amount: 900, currency: 'CLP' })).toBeNull();
  });
});
