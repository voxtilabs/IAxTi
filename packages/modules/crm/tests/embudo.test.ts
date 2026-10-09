import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  createDeal,
  createPipeline,
  ensureDefaultLossReasons,
  listLossReasons,
  moveDealStage,
} from '../application/deals';
import { ensureContactByPhone } from '../application/contacts';
import { getContactFicha } from '../application/activities';
import { getEmbudo, historiaDeEtapas } from '../application/embudo';
import type { Stage } from '../application/deals';

/**
 * El embudo que se puede leer (#695).
 *
 * `deals.won_at`, `deals.lost_at`, `deal_stage_history.from_stage_id` y
 * `.to_stage_id` se escribían desde el día uno y **ningún SELECT las
 * devolvía**. El CRM mostraba el presente del embudo y no podía decir si
 * estaba mejorando.
 *
 * Lo que estas pruebas cuidan, además de los números: que **retroceder de
 * etapa no rompa el promedio**. Mover una oportunidad a una etapa anterior es
 * normal —el cliente se arrepintió, el vendedor se adelantó— y es justo el
 * caso donde un contador paralelo se desincroniza.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let ventas: { pipelineId: string; stages: Stage[] };
let perdidaId: string;
let telefono = 56_955_000_000;

const ETAPAS = [
  { name: 'Nuevo', type: 'open' as const },
  { name: 'Cotizado', type: 'open' as const },
  { name: 'Cierre', type: 'open' as const },
  { name: 'Ganado', type: 'won' as const },
  { name: 'Perdido', type: 'lost' as const },
];

const etapa = (nombre: string): string => ventas.stages.find((s) => s.name === nombre)!.id;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('embudo') RETURNING id")).rows[0].id;
  const creado = await withTenant(admin, tenant, (c) =>
    createPipeline(c, { tenantId: tenant, name: 'Ventas', vertical: 'servicios', stages: ETAPAS }),
  );
  ventas = { pipelineId: creado.pipeline.id, stages: creado.stages };
  await withTenant(admin, tenant, (c) => ensureDefaultLossReasons(c, tenant));
  const motivos = await withTenant(admin, tenant, (c) => listLossReasons(c, tenant));
  perdidaId = motivos[0].id;
});

afterAll(async () => {
  for (const tabla of ['deal_stage_history', 'deals', 'stages', 'pipelines', 'loss_reasons', 'contacts', 'contact_identities', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

let ultimoContacto = '';

/** Una oportunidad nueva, con su propio contacto (uno abierta por pipeline). */
async function oportunidad(titulo: string, ownerId?: string): Promise<string> {
  telefono += 1;
  const { contact } = await withTenant(admin, tenant, (c) =>
    ensureContactByPhone(c, { tenantId: tenant, phone: `+${telefono}`, origin: 'whatsapp' }),
  );
  const deal = await withTenant(admin, tenant, (c) =>
    createDeal(c, {
      tenantId: tenant,
      contactId: contact.id,
      pipelineId: ventas.pipelineId,
      title: titulo,
      ownerId,
      actor: 'test',
    }),
  );
  ultimoContacto = contact.id;
  return deal.id;
}

function mover(dealId: string, nombre: string, extra: { reason?: string; lostReasonId?: string } = {}) {
  return withTenant(admin, tenant, (c) =>
    moveDealStage(c, {
      tenantId: tenant,
      dealId,
      stageId: etapa(nombre),
      actor: 'test',
      ...extra,
    }),
  );
}

const embudo = (ownerId?: string | null) =>
  withTenant(admin, tenant, (c) =>
    getEmbudo(c, { tenantId: tenant, pipelineId: ventas.pipelineId, ownerId }),
  );

const de = (e: Awaited<ReturnType<typeof embudo>>, nombre: string) =>
  e.etapas.find((x) => x.name === nombre)!;

describe('el embudo sale de la historia, no de un contador (#695)', () => {
  it('sin oportunidades: cero muestras y nada de conversión inventada', async () => {
    // Criterio 4: un negocio sin cierres ve un estado vacío, no un cero que
    // parece un resultado. `oportunidades: 0` es lo que lo distingue.
    const e = await embudo();
    expect(e.oportunidades).toBe(0);
    expect(e.ciclo.muestras).toBe(0);
    expect(e.ciclo.promedioDias).toBeNull();
    expect(e.seCaeEn).toBeNull();
    expect(e.etapas.map((x) => x.name)).toEqual(['Nuevo', 'Cotizado', 'Cierre', 'Ganado', 'Perdido']);
    expect(de(e, 'Nuevo').conversion, 'sin nadie que entre no hay porcentaje').toBeNull();
  });

  it('conversión etapa por etapa: entraron, avanzaron y dónde se cae', async () => {
    const a = await oportunidad('A: llega al cierre');
    const b = await oportunidad('B: se pierde cotizada');
    const c = await oportunidad('C: se queda en nuevo');

    await mover(a, 'Cotizado');
    await mover(a, 'Cierre');
    await mover(b, 'Cotizado');
    await mover(b, 'Perdido', { lostReasonId: perdidaId });

    const e = await embudo();
    expect(e.oportunidades).toBe(3);
    // Las tres entraron a Nuevo al nacer; dos siguieron.
    expect(de(e, 'Nuevo')).toMatchObject({ entraron: 3, avanzaron: 2, conversion: 0.667 });
    expect(de(e, 'Cotizado')).toMatchObject({ entraron: 2, avanzaron: 2 });
    expect(de(e, 'Cierre')).toMatchObject({ entraron: 1, avanzaron: 0, conversion: 0 });
    // B salió de Cotizado al cierre perdido: ahí se cae.
    expect(de(e, 'Cotizado').perdidas).toBe(1);
    expect(e.seCaeEn).toMatchObject({ name: 'Cotizado', perdidas: 1 });
    void c;
  });

  it('retroceder de etapa no descuenta un avance que sí pasó', async () => {
    // Criterio 5. B avanzó a Cotizado de verdad; que el vendedor la devuelva a
    // Nuevo no borra ese paso, y Nuevo no la cuenta dos veces por volver.
    const antes = await embudo();
    const d = await oportunidad('D: va y vuelve');
    await mover(d, 'Cotizado');
    await mover(d, 'Nuevo', { reason: 'el cliente pidió revisar el alcance' });

    const e = await embudo();
    expect(de(e, 'Nuevo').entraron, 'volver no la cuenta de nuevo').toBe(de(antes, 'Nuevo').entraron + 1);
    expect(de(e, 'Nuevo').avanzaron).toBe(de(antes, 'Nuevo').avanzaron + 1);
    expect(de(e, 'Cotizado').entraron).toBe(de(antes, 'Cotizado').entraron + 1);
  });

  it('ciclo de venta: won_at − created_at, sobre las ganadas', async () => {
    const g = await oportunidad('E: ganada');
    // La oportunidad nació hace cinco días: lo que hace falta para que el
    // promedio signifique algo es la distancia, no el momento.
    await admin.query("UPDATE deals SET created_at = now() - interval '5 days' WHERE id = $1", [g]);
    await mover(g, 'Cotizado');
    await mover(g, 'Ganado');

    const e = await embudo();
    expect(e.ciclo.muestras).toBe(1);
    expect(e.ciclo.promedioDias).toBeCloseTo(5, 1);
    expect(e.ciclo.medianaDias).toBeCloseTo(5, 1);
    expect(de(e, 'Ganado').entraron).toBe(1);
  });

  it('el dueño filtra el embudo, igual que la lista', async () => {
    const mio = '11111111-1111-4111-8111-111111111111';
    const ajeno = '22222222-2222-4222-8222-222222222222';
    const f = await oportunidad('F: mía', mio);
    await oportunidad('G: ajena', ajeno);
    await mover(f, 'Cotizado');

    const e = await embudo(mio);
    expect(e.oportunidades).toBe(1);
    expect(de(e, 'Nuevo')).toMatchObject({ entraron: 1, avanzaron: 1 });
    expect(de(e, 'Cotizado').entraron).toBe(1);
  });
});

describe('la historia de etapas de una oportunidad (#695)', () => {
  it('cada paso con su motivo, y el retroceso marcado', async () => {
    const h = await oportunidad('H: con historia');
    await mover(h, 'Cotizado');
    await mover(h, 'Nuevo', { reason: 'se cayó el presupuesto' });
    await mover(h, 'Perdido', { lostReasonId: perdidaId });

    const pasos = await withTenant(admin, tenant, (c) =>
      historiaDeEtapas(c, { tenantId: tenant, dealId: h }),
    );
    expect(pasos).toHaveLength(4);
    expect(pasos[0]).toMatchObject({ from: null, to: { name: 'Nuevo' }, backward: false });
    expect(pasos[1]).toMatchObject({ to: { name: 'Cotizado' }, backward: false });
    expect(pasos[2]).toMatchObject({
      from: { name: 'Cotizado' },
      to: { name: 'Nuevo' },
      backward: true,
      reason: 'se cayó el presupuesto',
    });
    // Al perder, el motivo de la lista queda escrito como razón del paso.
    expect(pasos[3].to.name).toBe('Perdido');
    expect(pasos[3].reason).toBeTruthy();
    // Y acá está la respuesta de la ficha: en qué etapa estaba al perderse.
    expect(pasos[3].from?.name).toBe('Nuevo');
  });

  it('la oportunidad sabe cuándo se cerró', async () => {
    const i = await oportunidad('I: se gana');
    const ganada = await mover(i, 'Ganado');
    expect(ganada.wonAt, 'won_at se escribía y nadie lo leía').toBeInstanceOf(Date);
    expect(ganada.lostAt).toBeNull();

    const j = await oportunidad('J: se pierde');
    const perdida = await mover(j, 'Perdido', { lostReasonId: perdidaId });
    expect(perdida.lostAt).toBeInstanceOf(Date);
    expect(perdida.wonAt).toBeNull();
  });
});

describe('la ficha del contacto dice cómo terminó (#695)', () => {
  it('ganada: con la fecha', async () => {
    const k = await oportunidad('K: ficha ganada');
    const contacto = ultimoContacto;
    await mover(k, 'Ganado');
    const ficha = await withTenant(admin, tenant, (c) => getContactFicha(c, tenant, contacto));
    const d = ficha.deals.find((x) => x.id === k)!;
    expect(d.won_at, 'la consulta de la ficha no proyectaba won_at').toBeTruthy();
    expect(d.lost_at).toBeNull();
    expect(d.lost_from_stage).toBeNull();
  });

  it('perdida: con la fecha Y la etapa en la que estaba', async () => {
    // Esto es lo que alguien pregunta al abrir la ficha: no «se perdió» —eso ya
    // lo decía la etiqueta— sino desde dónde. Sale de la historia.
    const l = await oportunidad('L: ficha perdida');
    const contacto = ultimoContacto;
    await mover(l, 'Cotizado');
    await mover(l, 'Cierre');
    await mover(l, 'Perdido', { lostReasonId: perdidaId });
    const ficha = await withTenant(admin, tenant, (c) => getContactFicha(c, tenant, contacto));
    const d = ficha.deals.find((x) => x.id === l)!;
    expect(d.lost_at).toBeTruthy();
    expect(d.lost_from_stage).toBe('Cierre');
    expect(d.won_at).toBeNull();
  });

  it('abierta: nada que mostrar, y eso no es un hueco', async () => {
    const m = await oportunidad('M: sigue abierta');
    const contacto = ultimoContacto;
    const ficha = await withTenant(admin, tenant, (c) => getContactFicha(c, tenant, contacto));
    const d = ficha.deals.find((x) => x.id === m)!;
    expect(d.won_at).toBeNull();
    expect(d.lost_at).toBeNull();
  });
});
