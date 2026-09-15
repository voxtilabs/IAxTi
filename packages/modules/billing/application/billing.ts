import type { Pool, PoolClient } from 'pg';
import { publishEvent, type Consumer, type EventEnvelope } from '@iaxti/core';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { changePlan, changeTenantState, getTenant, getTenantSettings } from '@iaxti/module-organizations';
import { createPaymentLink, listProviders } from '@iaxti/module-payments';
import { buildInvoiceLines, invoiceTotal, type InvoiceLine } from '../domain/pricing';

// billing (#67, SPEC §20): el ciclo mensual — factura con líneas
// separadas, cobro con el MISMO proveedor de pagos, y los estados del
// tenant (§6) aplicados automático y AUDITADO.

const DIAS_PARA_PAGAR = 5;

/** pg entrega las columnas date como Date de JS: siempre a 'AAAA-MM-DD'. */
function fecha(v: unknown): string {
  if (v instanceof Date) {
    // date sin hora: pg la interpreta a medianoche LOCAL — el día local es el correcto.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}
const DIAS_GRACIA_READONLY = 7;
/** §6: treinta días en solo lectura y la cuenta se suspende. */
const DIAS_HASTA_SUSPENDER = 30;

export interface Subscription {
  id: string;
  plan: string;
  status: 'active' | 'past_due' | 'cancelled';
  cycleStart: string;
  nextChargeAt: string;
  paymentMethodRef: string | null;
}

function rowToSubscription(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    plan: row.plan as string,
    status: row.status as Subscription['status'],
    cycleStart: fecha(row.cycle_start),
    nextChargeAt: fecha(row.next_charge_at),
    paymentMethodRef: (row.payment_method_ref as string) ?? null,
  };
}

export interface Invoice {
  id: string;
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  totalClp: number;
  status: 'issued' | 'paid' | 'overdue' | 'void';
  paymentLinkId: string | null;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    periodStart: fecha(row.period_start),
    periodEnd: fecha(row.period_end),
    lines: row.lines as InvoiceLine[],
    totalClp: Number(row.total_clp),
    status: row.status as Invoice['status'],
    paymentLinkId: (row.payment_link_id as string) ?? null,
    issuedAt: row.issued_at as Date,
    dueAt: row.due_at as Date,
    paidAt: (row.paid_at as Date) ?? null,
  };
}

/** La suscripción nace del plan que el tenant ya tiene (§9). */
export async function ensureSubscription(client: PoolClient, tenantId: string): Promise<Subscription> {
  const tenant = await getTenant(client, tenantId);
  const r = await client.query(
    `INSERT INTO subscriptions (tenant_id, plan, next_charge_at)
     VALUES ($1, $2, (date_trunc('month', now()) + interval '1 month')::date)
     ON CONFLICT (tenant_id) DO UPDATE SET plan = $2, updated_at = now()
     RETURNING *`,
    [tenantId, tenant.plan ?? 'base'],
  );
  return rowToSubscription(r.rows[0]);
}

export async function getSubscription(client: PoolClient, tenantId: string): Promise<Subscription | null> {
  const r = await client.query('SELECT * FROM subscriptions WHERE tenant_id = $1', [tenantId]);
  return r.rowCount === 0 ? null : rowToSubscription(r.rows[0]);
}

export async function listInvoices(client: PoolClient, tenantId: string): Promise<Invoice[]> {
  const r = await client.query(
    'SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY period_start DESC LIMIT 24',
    [tenantId],
  );
  return r.rows.map(rowToInvoice);
}

/** El costo de Meta del período, desde las tablas agregadas (#66). */
async function metaSpentUsd(
  client: PoolClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(SUM(value), 0) AS total FROM daily_metrics
      WHERE tenant_id = $1 AND metric = 'costo_meta_usd'
        AND day >= $2::date AND day < $3::date
        AND owner_id = '00000000-0000-0000-0000-000000000000'`,
    [tenantId, periodStart, periodEnd],
  );
  return Number(r.rows[0].total);
}

/**
 * Emite la factura del ciclo (idempotente por tenant+período) y la deja
 * COBRADA con un link del módulo payments si hay proveedor conectado.
 */
export async function issueInvoiceForCycle(
  client: PoolClient,
  input: { tenantId: string; periodStart: string; periodEnd: string; requestId?: string },
): Promise<Invoice | null> {
  const sub = await getSubscription(client, input.tenantId);
  if (!sub || sub.status === 'cancelled') return null;
  const settings = (await getTenantSettings(client, input.tenantId)) as {
    billing?: { iaAmpliacionClp?: number };
  };
  const lines = buildInvoiceLines({
    plan: sub.plan,
    metaSpentUsd: await metaSpentUsd(client, input.tenantId, input.periodStart, input.periodEnd),
    iaAmpliacionClp: settings.billing?.iaAmpliacionClp ?? null,
  });
  const r = await client.query(
    `INSERT INTO invoices (tenant_id, subscription_id, period_start, period_end, lines, total_clp, due_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(days => $7))
     ON CONFLICT (tenant_id, period_start) DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      sub.id,
      input.periodStart,
      input.periodEnd,
      JSON.stringify(lines),
      invoiceTotal(lines),
      DIAS_PARA_PAGAR,
    ],
  );
  if (r.rowCount === 0) return null; // ya emitida: idempotente
  const invoice = rowToInvoice(r.rows[0]);

  // El cobro con el MISMO módulo de pagos, si hay pasarela conectada.
  // SAVEPOINT: un cobro fallido NO aborta la transacción de la factura.
  await client.query('SAVEPOINT cobro');
  try {
    const providers = await listProviders(client, input.tenantId);
    if (providers.some((p) => p.active)) {
      const link = await createPaymentLink(client, {
        tenantId: input.tenantId,
        contactId: null,
        amountClp: invoice.totalClp,
        concept: `IAxTi plan ${sub.plan} — período ${invoice.periodStart}`,
        expiresHours: DIAS_PARA_PAGAR * 24,
        actorUserId: null,
      });
      await client.query('UPDATE invoices SET payment_link_id = $2 WHERE id = $1', [invoice.id, link.id]);
      invoice.paymentLinkId = link.id;
    }
    await client.query('RELEASE SAVEPOINT cobro');
  } catch {
    // Sin pasarela o sin credenciales: la factura queda emitida igual.
    await client.query('ROLLBACK TO SAVEPOINT cobro');
  }

  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: 'system',
    actorKind: 'system',
    action: 'billing.invoice.issue',
    resource: 'invoice',
    resourceId: invoice.id,
    result: 'ok',
    metadata: { totalClp: invoice.totalClp, lines: lines.length },
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'invoice.issued',
    tenantId: input.tenantId,
    payload: { invoiceId: invoice.id, totalClp: invoice.totalClp, periodStart: invoice.periodStart },
    actor: 'system',
    requestId: input.requestId,
  });
  return invoice;
}

/** payment.received con el link de una factura: la factura queda pagada
 *  y el tenant vuelve de past_due (§6). */
export function billingConsumers(): Consumer[] {
  const onPayment = async (event: EventEnvelope, client: PoolClient) => {
    const p = event.payload as Record<string, unknown>;
    const r = await client.query(
      `UPDATE invoices SET status = 'paid', paid_at = now()
        WHERE tenant_id = $1 AND payment_link_id = $2 AND status IN ('issued','overdue')
        RETURNING id`,
      [event.tenantId, p.linkId],
    );
    if (r.rowCount === 0) return; // no era una factura nuestra
    await client.query(
      `UPDATE subscriptions SET status = 'active', updated_at = now() WHERE tenant_id = $1`,
      [event.tenantId],
    );
    const tenant = await getTenant(client, event.tenantId);
    if (tenant.state === 'past_due' || tenant.state === 'read_only') {
      // read_only vuelve pasando por past_due (máquina de estados §6).
      if (tenant.state === 'read_only') await changeTenantState(client, event.tenantId, 'past_due');
      await changeTenantState(client, event.tenantId, 'active');
      await writeAudit(client, {
        tenantId: event.tenantId,
        actor: 'system',
        actorKind: 'system',
        action: 'billing.tenant.reactivate',
        resource: 'tenant',
        resourceId: event.tenantId,
        result: 'ok',
      });
    }
    await publishEvent(client, {
      name: 'invoice.paid',
      tenantId: event.tenantId,
      payload: { invoiceId: r.rows[0].id },
      actor: 'system',
    });
  };
  return [{ name: 'billing.payment_received', moduleId: 'billing', event: 'payment.received', handler: onPayment }];
}

/**
 * El barrido diario (#67): emite los ciclos vencidos, marca overdue y
 * aplica los estados del tenant (§6: past_due → read_only) — automático
 * y auditado.
 */
export async function sweepBilling(
  pool: Pool,
): Promise<{
  issued: number;
  overdue: number;
  readOnly: number;
  trialsVencidas: number;
  suspendidos: number;
}> {
  const res = { issued: 0, overdue: 0, readOnly: 0, trialsVencidas: 0, suspendidos: 0 };

  // 0. La prueba TERMINA (§6). `trial_ends_at` se escribía al crear el
  // tenant, se mostraba en el panel y el SuperAdmin la podía extender, y
  // nadie actuaba sobre ella: la prueba gratis no se acababa nunca.
  //
  // Quien ya eligió plan y tiene suscripción viva pasa a `active`. Quien no,
  // queda en solo lectura con sus datos intactos: los 30 días de gracia de
  // §6 los cuenta el paso 4 de este mismo barrido.
  const vencidasPrueba = await pool.query(
    `SELECT t.id, s.status AS suscripcion
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
      WHERE t.state = 'trial' AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at < now()`,
  );
  for (const fila of vencidasPrueba.rows) {
    await withTenant(pool, fila.id, async (client) => {
      const tenant = await getTenant(client, fila.id);
      if (tenant.state !== 'trial') return;
      const eligio = fila.suscripcion === 'active';
      await changeTenantState(client, fila.id, eligio ? 'active' : 'read_only');
      if (!eligio) {
        // La prueba traía los módulos de Crece regalados; se terminó.
        await changePlan(client, fila.id, 'base');
      }
      await writeAudit(client, {
        tenantId: fila.id,
        actor: 'system',
        actorKind: 'system',
        action: eligio ? 'billing.trial.convertida' : 'billing.trial.vencida',
        resource: 'tenant',
        resourceId: fila.id,
        result: 'ok',
        metadata: { trialEndsAt: tenant.trialEndsAt },
      });
      await publishEvent(client, {
        name: 'tenant.state_changed',
        tenantId: fila.id,
        payload: { from: 'trial', to: eligio ? 'active' : 'read_only', motivo: 'prueba vencida' },
        actor: 'system',
      });
      res.trialsVencidas += 1;
    });
  }

  // 1. Ciclos vencidos → factura del período que terminó + avanzar ciclo.
  const vencidas = await pool.query(
    `SELECT tenant_id, cycle_start, next_charge_at FROM subscriptions
      WHERE status <> 'cancelled' AND next_charge_at <= now()::date`,
  );
  for (const fila of vencidas.rows) {
    await withTenant(pool, fila.tenant_id, async (client) => {
      const invoice = await issueInvoiceForCycle(client, {
        tenantId: fila.tenant_id,
        periodStart: fecha(fila.cycle_start),
        periodEnd: fecha(fila.next_charge_at),
      });
      if (invoice) res.issued += 1;
      await client.query(
        `UPDATE subscriptions
            SET cycle_start = next_charge_at,
                next_charge_at = (next_charge_at + interval '1 month')::date,
                updated_at = now()
          WHERE tenant_id = $1`,
        [fila.tenant_id],
      );
    });
  }

  // 2. Facturas vencidas → overdue + tenant a past_due (§6, auditado).
  const impagas = await pool.query(
    `SELECT tenant_id, id FROM invoices WHERE status = 'issued' AND due_at < now()`,
  );
  for (const fila of impagas.rows) {
    await withTenant(pool, fila.tenant_id, async (client) => {
      await client.query(`UPDATE invoices SET status = 'overdue' WHERE id = $1`, [fila.id]);
      await client.query(
        `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE tenant_id = $1`,
        [fila.tenant_id],
      );
      const tenant = await getTenant(client, fila.tenant_id);
      if (tenant.state === 'active') {
        await changeTenantState(client, fila.tenant_id, 'past_due');
        await writeAudit(client, {
          tenantId: fila.tenant_id,
          actor: 'system',
          actorKind: 'system',
          action: 'billing.tenant.past_due',
          resource: 'tenant',
          resourceId: fila.tenant_id,
          result: 'ok',
          metadata: { invoiceId: fila.id },
        });
      }
      await publishEvent(client, {
        name: 'invoice.overdue',
        tenantId: fila.tenant_id,
        payload: { invoiceId: fila.id },
        actor: 'system',
      });
      res.overdue += 1;
    });
  }

  // 3. Overdue con la gracia cumplida → read_only (§6, auditado).
  const agotadas = await pool.query(
    `SELECT DISTINCT tenant_id FROM invoices
      WHERE status = 'overdue' AND due_at < now() - make_interval(days => $1)`,
    [DIAS_GRACIA_READONLY],
  );
  for (const fila of agotadas.rows) {
    await withTenant(pool, fila.tenant_id, async (client) => {
      const tenant = await getTenant(client, fila.tenant_id);
      if (tenant.state !== 'past_due') return;
      await changeTenantState(client, fila.tenant_id, 'read_only');
      await writeAudit(client, {
        tenantId: fila.tenant_id,
        actor: 'system',
        actorKind: 'system',
        action: 'billing.tenant.read_only',
        resource: 'tenant',
        resourceId: fila.tenant_id,
        result: 'ok',
      });
      res.readOnly += 1;
    });
  }

  // 4. Treinta días en solo lectura → suspendido (§6). La transición existía
  // solo a mano, desde el panel del SuperAdmin: el plazo no lo contaba nadie.
  // Es barata y reversible — el tenant ya no enviaba nada (#204).
  const enSoloLectura = await pool.query(
    `SELECT id FROM tenants
      WHERE state = 'read_only' AND state_since < now() - make_interval(days => $1)`,
    [DIAS_HASTA_SUSPENDER],
  );
  for (const fila of enSoloLectura.rows) {
    await withTenant(pool, fila.id, async (client) => {
      const tenant = await getTenant(client, fila.id);
      if (tenant.state !== 'read_only') return;
      await changeTenantState(client, fila.id, 'suspended');
      await writeAudit(client, {
        tenantId: fila.id,
        actor: 'system',
        actorKind: 'system',
        action: 'billing.tenant.suspended',
        resource: 'tenant',
        resourceId: fila.id,
        result: 'ok',
        metadata: { desde: tenant.stateSince },
      });
      await publishEvent(client, {
        name: 'tenant.state_changed',
        tenantId: fila.id,
        payload: { from: 'read_only', to: 'suspended', motivo: 'treinta días en solo lectura' },
        actor: 'system',
      });
      res.suspendidos += 1;
    });
  }
  return res;
}
