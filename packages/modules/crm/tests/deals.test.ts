import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { resolveValueClp, validateStages } from '../domain/pipeline';
import {
  createDeal,
  createPipeline,
  ensureDefaultLossReasons,
  listLossReasons,
  listStalledDeals,
  markStalledDeals,
  moveDealStage,
  updateDeal,
} from '../application/deals';
import { ensureContactByPhone } from '../application/contacts';
import type { Stage } from '../application/deals';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;
let contacto: string;
let ventas: { pipelineId: string; stages: Stage[] };

const etapasVentas = [
  { name: 'Nuevo', type: 'open' as const, probability: 10, expectedDays: 7 },
  { name: 'Cotizado', type: 'open' as const, probability: 50, expectedDays: 7 },
  { name: 'Ganado', type: 'won' as const },
  { name: 'Perdido', type: 'lost' as const },
];

async function eventos(nombre: string, tenant: string): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND tenant_id = $2',
    [nombre, tenant],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, pipelines, stages, deals, loss_reasons, deal_stage_history TO iaxti_app',
  );
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));

  const a = await admin.query("INSERT INTO tenants (name) VALUES ('deals-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('deals-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;

  const { contact } = await withTenant(app, tenantA, (c) =>
    ensureContactByPhone(c, { tenantId: tenantA, phone: '+56977778888', origin: 'whatsapp' }),
  );
  contacto = contact.id;

  const creado = await withTenant(app, tenantA, (c) =>
    createPipeline(c, { tenantId: tenantA, name: 'Ventas', vertical: 'servicios', stages: etapasVentas }),
  );
  ventas = { pipelineId: creado.pipeline.id, stages: creado.stages };
  await withTenant(app, tenantA, (c) => ensureDefaultLossReasons(c, tenantA));
});

afterAll(async () => {
  await app.end();
  for (const t of [tenantA, tenantB]) {
    await admin.query('DELETE FROM deal_stage_history WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM deals WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM stages WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM pipelines WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM loss_reasons WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
  await admin.end();
});

describe('dominio de pipelines (SPEC §10)', () => {
  it('exige al menos una etapa abierta, una ganada y una perdida', () => {
    expect(() => validateStages([{ name: 'Solo', type: 'open' }])).toThrow(/al menos/);
    expect(() =>
      validateStages([
        { name: 'Nuevo', type: 'open' },
        { name: 'Nuevo', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ]),
    ).toThrow(/repetida/);
    expect(() => validateStages(etapasVentas)).not.toThrow();
  });

  it('el valor en UF exige la UF del día y congela el equivalente en pesos', () => {
    expect(resolveValueClp(100, 'UF', 39_265.5)).toEqual({ valueClp: 3_926_550, ufRate: 39_265.5 });
    expect(resolveValueClp(250_000, 'CLP')).toEqual({ valueClp: 250_000, ufRate: null });
    expect(() => resolveValueClp(100, 'UF')).toThrow(/UF del día/);
  });
});

describe('oportunidades (rol de aplicación, RLS activa)', () => {
  it('la oportunidad nace en la primera etapa abierta y publica deal.created', async () => {
    const deal = await withTenant(app, tenantA, (c) =>
      createDeal(c, {
        tenantId: tenantA,
        contactId: contacto,
        pipelineId: ventas.pipelineId,
        title: 'Plan mensual',
        value: 250_000,
      }),
    );
    expect(deal.stageId).toBe(ventas.stages[0].id);
    expect(deal.status).toBe('open');
    expect(deal.valueClp).toBe(250_000);
    expect(await eventos('deal.created', tenantA)).toBe(1);
  });

  it('un contacto tiene a lo más una oportunidad abierta por pipeline', async () => {
    await expect(
      withTenant(app, tenantA, (c) =>
        createDeal(c, {
          tenantId: tenantA,
          contactId: contacto,
          pipelineId: ventas.pipelineId,
          title: 'Duplicada',
        }),
      ),
    ).rejects.toThrow(/ya tiene una oportunidad abierta/);
  });

  it('retroceder de etapa exige motivo y queda en la historia', async () => {
    const abierta = await admin.query(
      "SELECT id FROM deals WHERE tenant_id = $1 AND status = 'open'",
      [tenantA],
    );
    const dealId = abierta.rows[0].id;
    const [nuevo, cotizado] = ventas.stages;

    await withTenant(app, tenantA, (c) =>
      moveDealStage(c, { tenantId: tenantA, dealId, stageId: cotizado.id }),
    );
    await expect(
      withTenant(app, tenantA, (c) =>
        moveDealStage(c, { tenantId: tenantA, dealId, stageId: nuevo.id }),
      ),
    ).rejects.toThrow(/motivo/);

    await withTenant(app, tenantA, (c) =>
      moveDealStage(c, {
        tenantId: tenantA,
        dealId,
        stageId: nuevo.id,
        reason: 'la clienta pidió recotizar',
      }),
    );
    const historia = await admin.query(
      'SELECT reason FROM deal_stage_history WHERE tenant_id = $1 AND deal_id = $2 ORDER BY created_at',
      [tenantA, dealId],
    );
    expect(historia.rows.at(-1)?.reason).toBe('la clienta pidió recotizar');
    expect(await eventos('deal.stage_changed', tenantA)).toBe(2);
  });

  it('cerrar en lost exige motivo de la lista configurable; won libera el cupo', async () => {
    const abierta = await admin.query(
      "SELECT id FROM deals WHERE tenant_id = $1 AND status = 'open'",
      [tenantA],
    );
    const dealId = abierta.rows[0].id;
    const perdido = ventas.stages.find((s) => s.type === 'lost')!;
    const ganado = ventas.stages.find((s) => s.type === 'won')!;

    await expect(
      withTenant(app, tenantA, (c) =>
        moveDealStage(c, { tenantId: tenantA, dealId, stageId: perdido.id }),
      ),
    ).rejects.toThrow(/motivo de la lista/);

    const ganada = await withTenant(app, tenantA, (c) =>
      moveDealStage(c, { tenantId: tenantA, dealId, stageId: ganado.id }),
    );
    expect(ganada.status).toBe('won');
    expect(await eventos('deal.won', tenantA)).toBe(1);

    // El cupo quedó libre: se puede abrir otra, y cerrarla como perdida con motivo.
    const segunda = await withTenant(app, tenantA, (c) =>
      createDeal(c, {
        tenantId: tenantA,
        contactId: contacto,
        pipelineId: ventas.pipelineId,
        title: 'Segundo intento',
      }),
    );
    const motivos = await withTenant(app, tenantA, (c) => listLossReasons(c, tenantA));
    expect(motivos.map((m) => m.label)).toContain('Precio');
    const perdida = await withTenant(app, tenantA, (c) =>
      moveDealStage(c, {
        tenantId: tenantA,
        dealId: segunda.id,
        stageId: perdido.id,
        lostReasonId: motivos.find((m) => m.label === 'Precio')!.id,
      }),
    );
    expect(perdida.status).toBe('lost');
    expect(perdida.lostReasonId).toBe(motivos.find((m) => m.label === 'Precio')!.id);
    expect(await eventos('deal.lost', tenantA)).toBe(1);

    // Cerrada no se mueve más.
    await expect(
      withTenant(app, tenantA, (c) =>
        moveDealStage(c, { tenantId: tenantA, dealId: segunda.id, stageId: ganado.id }),
      ),
    ).rejects.toThrow(/ya está cerrada/);
  });

  it('updateDeal en UF guarda también el valor en pesos al día', async () => {
    const deal = await withTenant(app, tenantA, (c) =>
      createDeal(c, {
        tenantId: tenantA,
        contactId: contacto,
        pipelineId: ventas.pipelineId,
        title: 'Proyecto en UF',
      }),
    );
    const enUf = await withTenant(app, tenantA, (c) =>
      updateDeal(c, { tenantId: tenantA, dealId: deal.id, value: 120, currency: 'UF', ufRate: 39_265.5 }),
    );
    expect(enUf.valueClp).toBe(4_711_860);
    expect(enUf.ufRate).toBe(39_265.5);
    await expect(
      withTenant(app, tenantA, (c) =>
        updateDeal(c, { tenantId: tenantA, dealId: deal.id, value: 130, currency: 'UF' }),
      ),
    ).rejects.toThrow(/UF del día/);
  });

  it('la oportunidad estancada se marca una vez, aparece en el resumen y moverla la limpia', async () => {
    // Pipeline aparte con 0 días esperados: cualquier deal queda estancado ya.
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56966665555', origin: 'manual' }),
    );
    const postventa = await withTenant(app, tenantA, (c) =>
      createPipeline(c, {
        tenantId: tenantA,
        name: 'Postventa',
        stages: [
          { name: 'Pendiente', type: 'open', expectedDays: 0 },
          { name: 'Resuelto', type: 'won' },
          { name: 'Descartado', type: 'lost' },
        ],
      }),
    );
    const deal = await withTenant(app, tenantA, (c) =>
      createDeal(c, {
        tenantId: tenantA,
        contactId: contact.id,
        pipelineId: postventa.pipeline.id,
        title: 'Garantía',
      }),
    );

    const marcadas = await withTenant(app, tenantA, (c) => markStalledDeals(c, tenantA));
    expect(marcadas).toContain(deal.id);
    expect(await eventos('deal.stalled', tenantA)).toBe(1);

    // Segunda pasada: no re-marca ni duplica el evento.
    expect(await withTenant(app, tenantA, (c) => markStalledDeals(c, tenantA))).toEqual([]);
    expect(await eventos('deal.stalled', tenantA)).toBe(1);

    const resumen = await withTenant(app, tenantA, (c) => listStalledDeals(c, tenantA));
    expect(resumen.map((d) => d.id)).toContain(deal.id);
    expect(resumen[0].stageName).toBe('Pendiente');

    // Moverla limpia la marca y desaparece del resumen.
    await withTenant(app, tenantA, (c) =>
      moveDealStage(c, {
        tenantId: tenantA,
        dealId: deal.id,
        stageId: postventa.stages.find((s) => s.type === 'won')!.id,
      }),
    );
    expect(await withTenant(app, tenantA, (c) => listStalledDeals(c, tenantA))).toEqual([]);
  });

  it('un tenant no ve pipelines ni oportunidades de otro (RLS)', async () => {
    const pipelines = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM pipelines'));
    const deals = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM deals'));
    expect(pipelines.rowCount).toBe(0);
    expect(deals.rowCount).toBe(0);
  });
});
