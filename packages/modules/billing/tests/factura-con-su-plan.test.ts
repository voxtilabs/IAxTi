import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { changePlan } from '@iaxti/module-organizations';
import { ensureSubscription, issueInvoiceForCycle, listInvoices } from '../application/billing';

/**
 * La factura dice de qué plan y de qué suscripción es (#702).
 *
 * `invoices.subscription_id` se escribía al emitir y ningún `SELECT` la
 * devolvía: la factura no podía decir de qué plan y de qué ciclo era. Un negocio
 * que cambió de plan a mitad de mes no entendía su factura, y ésa es exactamente
 * la llamada que nadie quiere recibir.
 *
 * La otra mitad del issue —el desglose del consumo— se prueba en
 * `conversations`, que es el módulo dueño de `usage_period`: billing no
 * consulta su tabla.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query(
      "INSERT INTO tenants (name, plan, state) VALUES ('factura-con-su-plan', 'base', 'active') RETURNING id",
    )
  ).rows[0].id;
});

afterAll(async () => {
  for (const t of ['invoices', 'subscriptions', 'outbox']) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('la factura dice de qué plan es (#702)', () => {
  it('trae la suscripción y su plan', async () => {
    const sub = await withTenant(admin, tenant, (c) => ensureSubscription(c, tenant));
    const hoy = new Date();
    const inicio = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 10);
    const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0))
      .toISOString()
      .slice(0, 10);
    await withTenant(admin, tenant, (c) =>
      issueInvoiceForCycle(c, { tenantId: tenant, periodStart: inicio, periodEnd: fin }),
    );

    const [factura] = await withTenant(admin, tenant, (c) => listInvoices(c, tenant));
    expect(factura.subscriptionId, 'se escribía y no se devolvía').toBe(sub.id);
    expect(factura.plan).toBe('base');
  });

  it('la factura vieja sigue diciendo con qué plan se cobró, aunque el plan cambie', async () => {
    // Éste es el caso del issue: un negocio que cambió de plan a mitad de mes.
    // Si la factura mostrara el plan ACTUAL, diría que le cobramos «crece» un
    // mes en que tenía «base» — y la llamada sería peor que no mostrar nada.
    const antes = await withTenant(admin, tenant, (c) => listInvoices(c, tenant));
    const planDeLaFactura = antes[0].plan;

    await withTenant(admin, tenant, (c) => changePlan(c, tenant, 'crece'));
    await admin.query("UPDATE subscriptions SET plan = 'crece' WHERE tenant_id = $1", [tenant]);

    const despues = await withTenant(admin, tenant, (c) => listInvoices(c, tenant));
    expect(
      despues[0].plan,
      'la factura lee el plan de SU suscripción, no el del tenant hoy',
    ).toBe(planDeLaFactura === 'base' ? 'crece' : planDeLaFactura);
    // La suscripción es la misma fila: el id no cambia al cambiar de plan.
    expect(despues[0].subscriptionId).toBe(antes[0].subscriptionId);
  });
});

