import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ganadoDelMes } from '../application/board';
import { createContact } from '../application/contacts';
import { createDeal, createPipeline } from '../application/deals';

/**
 * Lo ganado este mes contra el mes anterior a la misma fecha (#1346).
 *
 * Cada monto es distinto para que la suma diga QUÉ entró, no solo cuánto: si
 * el borde de la zona fallara, los 5.000 de la noche del 31 aparecerían en
 * noviembre y la prueba lo nombraría.
 *
 * Dos instantes fijos (regla de testing): mitad de noviembre, donde el corte
 * cae en medio de octubre, y 31 de marzo, donde febrero es más corto y el
 * corte se topa en el fin de febrero.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let pipelineId: string;
let n = 0;

/** Una oportunidad ganada en `wonAt` (o ganada y reabierta, si `reabierta`). */
async function ganada(valor: number, wonAt: string, reabierta = false): Promise<void> {
  n += 1;
  const k = await withTenant(admin, tenant, (c) =>
    createContact(c, { tenantId: tenant, name: `Cliente ${n}`, phone: `+5691200${String(n).padStart(4, '0')}` }),
  );
  const d = await withTenant(admin, tenant, (c) =>
    createDeal(c, { tenantId: tenant, contactId: k.id, pipelineId, title: `Venta ${n}`, value: valor, currency: 'CLP' }),
  );
  await withTenant(admin, tenant, (c) =>
    c.query('UPDATE deals SET status = $3, won_at = $4 WHERE tenant_id = $1 AND id = $2', [
      tenant,
      d.id,
      reabierta ? 'open' : 'won',
      wonAt,
    ]),
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (
    await admin.query("INSERT INTO tenants (name, timezone) VALUES ('ganado-1346', 'America/Santiago') RETURNING id")
  ).rows[0].id;
  const pipe = await withTenant(admin, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  pipelineId = pipe.pipeline.id;

  // Noviembre / octubre (Santiago en UTC-3).
  await ganada(100, '2026-11-01T04:00:00Z'); //   1 nov 01:00 local → este mes
  await ganada(5000, '2026-11-01T02:00:00Z'); // 31 oct 23:00 local → octubre, DESPUÉS del corte
  await ganada(20, '2026-10-10T15:00:00Z'); //   10 oct → mes anterior, antes del corte
  await ganada(3000, '2026-10-20T15:00:00Z'); // 20 oct → después del corte
  await ganada(700, '2026-11-05T15:00:00Z', true); // ganada y reabierta → no es venta
  await ganada(9, '2026-11-15T16:00:00Z'); //    una hora DESPUÉS de «ahora» → todavía no

  // Marzo / febrero.
  await ganada(40, '2026-02-28T20:00:00Z'); //   último día de febrero
});

afterAll(async () => {
  await admin.end();
});

describe('lo ganado del mes', () => {
  it('a mitad de mes compara contra el mes anterior cortado en el mismo punto, en la zona del negocio', async () => {
    const r = await withTenant(admin, tenant, (c) =>
      ganadoDelMes(c, tenant, pipelineId, new Date('2026-11-15T15:00:00Z')),
    );
    expect(r.esteMesClp).toBe(100);
    expect(r.mesAnteriorClp).toBe(20);
    // 15 oct 12:00 en Santiago (UTC-3).
    expect(r.corteDelMesAnterior.toISOString()).toBe('2026-10-15T15:00:00.000Z');
    expect([r.mes, r.dia, r.mesAnteriorCompleto]).toEqual([11, 15, false]);
  });

  it('si el mes anterior es más corto, lo cuenta entero y el corte es su fin', async () => {
    const r = await withTenant(admin, tenant, (c) =>
      ganadoDelMes(c, tenant, pipelineId, new Date('2026-03-31T15:00:00Z')),
    );
    expect(r.esteMesClp).toBe(0);
    expect(r.mesAnteriorClp).toBe(40);
    // 1 mar 00:00 en Santiago (UTC-3 en marzo).
    expect(r.corteDelMesAnterior.toISOString()).toBe('2026-03-01T03:00:00.000Z');
    expect([r.mes, r.dia, r.mesAnteriorCompleto]).toEqual([3, 31, true]);
  });

  it('no mira otros negocios', async () => {
    const otro = (await admin.query("INSERT INTO tenants (name) VALUES ('ganado-otro') RETURNING id")).rows[0].id;
    const r = await withTenant(admin, otro, (c) =>
      ganadoDelMes(c, otro, pipelineId, new Date('2026-11-15T15:00:00Z')),
    );
    expect(r.esteMesClp).toBe(0);
    expect(r.mesAnteriorClp).toBe(0);
  });
});
