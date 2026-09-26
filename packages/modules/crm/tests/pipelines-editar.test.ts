import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createPipeline, getPipelineStages, createDeal } from '../application/deals';
import {
  addStage,
  deleteStage,
  renamePipeline,
  reorderStages,
  updateStage,
} from '../application/pipelines';

// Editar el embudo (issue 248): los pipelines se creaban con el configurador
// y quedaban congelados. La regla de fondo: editar la FORMA nunca puede
// perder una oportunidad.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let pipeline: string;
let contacto: string;

// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('pipelines-test') RETURNING id");
  tenant = t.rows[0].id;
  const p = await en((c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  pipeline = p.pipeline.id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Ema', '+56977770001', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('editar el embudo', () => {
  it('renombra el pipeline y la etapa, y ajusta probabilidad y días', async () => {
    const p = await en((c) => renamePipeline(c, { tenantId: tenant, pipelineId: pipeline, name: 'Ventas 2026' }));
    expect(p.name).toBe('Ventas 2026');

    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const cotizado = etapas.find((e) => e.name === 'Cotizado')!;
    const editada = await en((c) =>
      updateStage(c, { tenantId: tenant, stageId: cotizado.id, name: 'Cotización enviada', probability: 60, expectedDays: 3 }),
    );
    expect(editada.name).toBe('Cotización enviada');
    expect(editada.probability).toBe(60);
    expect(editada.expectedDays).toBe(3);

    await expect(
      en((c) => updateStage(c, { tenantId: tenant, stageId: cotizado.id, probability: 140 })),
    ).rejects.toThrow(/0 a 100/);
  });

  it('la etapa nueva entra ANTES del cierre, no después de "Ganado"', async () => {
    const nueva = await en((c) =>
      addStage(c, { tenantId: tenant, pipelineId: pipeline, name: 'Visita agendada', expectedDays: 2 }),
    );
    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const nombres = etapas.map((e) => e.name);
    expect(nombres.indexOf('Visita agendada')).toBeLessThan(nombres.indexOf('Ganado'));
    expect(nueva.type).toBe('open');
    // Las posiciones siguen siendo consecutivas.
    expect(etapas.map((e) => e.position)).toEqual(etapas.map((_, i) => i));
  });

  it('reordena las abiertas y deja las de cierre al final', async () => {
    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const abiertas = etapas.filter((e) => e.type === 'open');
    const alReves = [...abiertas].reverse().map((e) => e.id);
    const final = await en((c) => reorderStages(c, { tenantId: tenant, pipelineId: pipeline, stageIds: alReves }));

    expect(final.slice(0, abiertas.length).map((e) => e.id)).toEqual(alReves);
    expect(final[final.length - 2].type).toBe('won');
    expect(final[final.length - 1].type).toBe('lost');
    expect(final.map((e) => e.position)).toEqual(final.map((_, i) => i));
  });

  it('reordenar a medias se rechaza: o están todas las abiertas, o ninguna', async () => {
    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const una = etapas.find((e) => e.type === 'open')!;
    await expect(
      en((c) => reorderStages(c, { tenantId: tenant, pipelineId: pipeline, stageIds: [una.id] })),
    ).rejects.toThrow(/todas las etapas abiertas/);
  });

  it('una etapa CON oportunidades no se borra, y dice cuántas hay', async () => {
    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const primera = etapas.find((e) => e.type === 'open')!;
    await en((c) =>
      createDeal(c, { tenantId: tenant, contactId: contacto, pipelineId: pipeline, stageId: primera.id, title: 'Cotización piso' }),
    );
    await expect(
      en((c) => deleteStage(c, { tenantId: tenant, stageId: primera.id })),
    ).rejects.toThrow(/1 oportunidad\. Muévelas/);
  });

  it('las de cierre no se borran, y el embudo nunca se queda sin abiertas', async () => {
    const etapas = await en((c) => getPipelineStages(c, tenant, pipeline));
    const ganado = etapas.find((e) => e.type === 'won')!;
    await expect(en((c) => deleteStage(c, { tenantId: tenant, stageId: ganado.id }))).rejects.toThrow(
      /etapas de cierre/,
    );

    // Se borran las abiertas vacías hasta que queda una sola: ahí se planta.
    for (const etapa of etapas.filter((e) => e.type === 'open')) {
      await en((c) => deleteStage(c, { tenantId: tenant, stageId: etapa.id })).catch(() => undefined);
    }
    const quedan = await en((c) => getPipelineStages(c, tenant, pipeline));
    expect(quedan.filter((e) => e.type === 'open').length).toBeGreaterThanOrEqual(1);
    expect(quedan.map((e) => e.position)).toEqual(quedan.map((_, i) => i));
  });
});
