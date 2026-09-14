import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addProvider } from '@iaxti/module-payments';
import { buildInvoiceLines, invoiceTotal, planPricing } from '../domain/pricing';
import {
  billingConsumers,
  ensureSubscription,
  issueInvoiceForCycle,
  listInvoices,
  sweepBilling,
} from '../application/billing';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

beforeAll(async () => {
  process.env.BILLING_TEST_CRED = 'sandbox';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan, state) VALUES ('billing-test', 'crece', 'active') RETURNING id",
  );
  tenant = t.rows[0].id;
  // Consumo de Meta del ciclo (tabla agregada de #66): USD 40 con USD 25 incluidos.
  await admin.query(
    `INSERT INTO daily_metrics (tenant_id, day, metric, value)
     VALUES ($1, date_trunc('month', now() - interval '1 month')::date + 3, 'costo_meta_usd', 40)`,
    [tenant],
  );
  await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulador',
      credentialRef: 'BILLING_TEST_CRED',
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  await admin.query(`DELETE FROM invoices WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM payment_links WHERE tenant_id = $1 AND status <> 'paid'`, [tenant]);
  await admin.query(`DELETE FROM daily_metrics WHERE tenant_id = $1`, [tenant]);
  await admin.query(`DELETE FROM outbox WHERE tenant_id = $1`, [tenant]);
  await admin.end();
});

describe('precios (#67)', () => {
  it('las líneas van SEPARADAS: plan, exceso de Meta y ampliación de IA', () => {
    const lines = buildInvoiceLines({ plan: 'crece', metaSpentUsd: 40, iaAmpliacionClp: 15000 });
    expect(lines.map((l) => l.concepto)).toEqual(['plan', 'exceso_meta', 'ampliacion_ia']);
    expect(lines[0].amountClp).toBe(planPricing('crece').monthlyClp);
    expect(lines[1].amountClp).toBeGreaterThan(0); // 15 USD de exceso
    expect(invoiceTotal(lines)).toBe(lines.reduce((a, l) => a + l.amountClp, 0));

    // Sin exceso ni ampliación: la factura es SOLO el plan.
    const simple = buildInvoiceLines({ plan: 'base', metaSpentUsd: 2 });
    expect(simple).toHaveLength(1);
  });
});

describe('el ciclo (#67)', () => {
  it('la suscripción nace del plan del tenant; la factura es idempotente y cobra con payments', async () => {
    const sub = await withTenant(admin, tenant, (c) => ensureSubscription(c, tenant));
    expect(sub.plan).toBe('crece');
    expect(sub.status).toBe('active');

    // El período del test: el mes pasado (donde está el consumo de Meta).
    await admin.query(
      `UPDATE subscriptions SET cycle_start = (date_trunc('month', now() - interval '1 month'))::date,
        next_charge_at = (date_trunc('month', now()))::date WHERE tenant_id = $1`,
      [tenant],
    );
    const inicio = (await admin.query(
      `SELECT to_char(cycle_start, 'YYYY-MM-DD') AS cycle_start, to_char(next_charge_at, 'YYYY-MM-DD') AS next_charge_at
         FROM subscriptions WHERE tenant_id = $1`,
      [tenant],
    )).rows[0];

    const invoice = await withTenant(admin, tenant, (c) =>
      issueInvoiceForCycle(c, {
        tenantId: tenant,
        periodStart: inicio.cycle_start,
        periodEnd: inicio.next_charge_at,
      }),
    );
    expect(invoice).not.toBeNull();
    expect(invoice!.lines.map((l) => l.concepto)).toEqual(['plan', 'exceso_meta']);
    expect(invoice!.paymentLinkId).not.toBeNull(); // cobrada con el simulador
    expect(invoice!.status).toBe('issued');

    // Idempotente: el mismo período no se emite dos veces.
    const repetida = await withTenant(admin, tenant, (c) =>
      issueInvoiceForCycle(c, {
        tenantId: tenant,
        periodStart: inicio.cycle_start,
        periodEnd: inicio.next_charge_at,
      }),
    );
    expect(repetida).toBeNull();

    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'invoice.issued'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('el pago del link marca la factura y el tenant vuelve de past_due (§6)', async () => {
    // Simular el impago primero: overdue + past_due.
    await admin.query(`UPDATE invoices SET status = 'overdue' WHERE tenant_id = $1`, [tenant]);
    await admin.query(`UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1`, [tenant]);
    await admin.query(`UPDATE tenants SET state = 'past_due' WHERE id = $1`, [tenant]);

    const factura = (await withTenant(admin, tenant, (c) => listInvoices(c, tenant)))[0];
    const consumer = billingConsumers()[0];
    const client = await admin.connect();
    try {
      await consumer.handler(
        {
          id: 1,
          name: 'payment.received',
          tenantId: tenant,
          payload: { linkId: factura.paymentLinkId },
          actor: 'system',
          requestId: null,
          version: 1,
          occurredAt: new Date(),
        } as never,
        client,
      );
    } finally {
      client.release();
    }
    const pagada = (await withTenant(admin, tenant, (c) => listInvoices(c, tenant)))[0];
    expect(pagada.status).toBe('paid');
    const estado = await admin.query('SELECT state FROM tenants WHERE id = $1', [tenant]);
    expect(estado.rows[0].state).toBe('active'); // volvió solo
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'invoice.paid'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('el barrido: emite el ciclo vencido, marca overdue y aplica past_due → read_only', async () => {
    // El ciclo quedó vencido, pero el período YA se facturó en el test
    // anterior: el sweep NO duplica (idempotente) y el ciclo avanza igual.
    const res1 = await sweepBilling(admin);
    expect(res1.issued).toBe(0);
    const ciclo = (await admin.query(
      `SELECT to_char(next_charge_at, 'YYYY-MM-DD') AS n FROM subscriptions WHERE tenant_id = $1`,
      [tenant],
    )).rows[0];
    expect(ciclo.n > new Date().toISOString().slice(0, 10)).toBe(true); // avanzó

    // Una factura nueva del ciclo actual, para el camino del impago.
    const inicio = (await admin.query(
      `SELECT to_char(cycle_start, 'YYYY-MM-DD') AS s, to_char(next_charge_at, 'YYYY-MM-DD') AS e
         FROM subscriptions WHERE tenant_id = $1`,
      [tenant],
    )).rows[0];
    await withTenant(admin, tenant, (c) =>
      issueInvoiceForCycle(c, { tenantId: tenant, periodStart: inicio.s, periodEnd: inicio.e }),
    );

    // Vencida hace 6 días: overdue + past_due, pero la GRACIA (7 días)
    // todavía no se cumple — read_only aún no.
    await admin.query(
      `UPDATE invoices SET due_at = now() - interval '6 days' WHERE tenant_id = $1 AND status = 'issued'`,
      [tenant],
    );
    const res2 = await sweepBilling(admin);
    expect(res2.overdue).toBe(1);
    expect(res2.readOnly).toBe(0);
    expect((await admin.query('SELECT state FROM tenants WHERE id = $1', [tenant])).rows[0].state).toBe('past_due');

    // Cumplida la gracia: read_only.
    await admin.query(
      `UPDATE invoices SET due_at = now() - interval '8 days' WHERE tenant_id = $1 AND status = 'overdue'`,
      [tenant],
    );
    const res3 = await sweepBilling(admin);
    expect(res3.readOnly).toBe(1);
    expect((await admin.query('SELECT state FROM tenants WHERE id = $1', [tenant])).rows[0].state).toBe('read_only');

    // Auditado: las transiciones quedaron en el libro.
    const audit = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'billing.tenant%' ORDER BY id`,
      [tenant],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['billing.tenant.past_due', 'billing.tenant.read_only']),
    );
  });
});
