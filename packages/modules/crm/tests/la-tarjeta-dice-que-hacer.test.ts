import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { listDeals } from '../application/board';
import { createContact } from '../application/contacts';
import { createActivity, completeActivity } from '../application/activities';
import { createDeal, createPipeline } from '../application/deals';

/**
 * La tarjeta dice qué hay que hacer y cuándo (#1302).
 *
 * El tablero mostraba título, monto, contacto y «Estancada». Con eso se lee
 * el tablero pero no se trabaja: no decía qué hay que hacer con cada
 * oportunidad ni cuándo. El dato estaba en `activities` desde la migración
 * 0003 —`deal_id`, `due_at`, `done_at`— y no lo leía nadie.
 *
 * Todo lo que mide el tiempo recibe un INSTANTE FIJO. Una prueba que mira el
 * reloj de la máquina pasa o falla según la hora a la que se corra, que es
 * exactamente lo que le pasaba a la del cupo (#1305).
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let pipelineId: string;
/** El contacto de la ÚLTIMA oportunidad creada, para colgarle actividades. */
let contactId: string;
let siguiente = 0;

/** Mediodía de Santiago: lejos del borde del día por los dos lados. */
const AHORA = new Date('2026-11-08T15:00:00Z');
const dias = (n: number) => new Date(AHORA.getTime() + n * 86_400_000);

/**
 * Un contacto propio por oportunidad: el producto no deja dos abiertas del
 * mismo contacto en el mismo embudo, y es una regla con razón —no es una
 * limitación de la prueba—.
 */
async function nuevoDeal(title: string): Promise<string> {
  siguiente += 1;
  const k = await withTenant(admin, tenant, (c) =>
    createContact(c, {
      tenantId: tenant,
      name: `Persona ${siguiente}`,
      phone: `+5691100${String(siguiente).padStart(4, '0')}`,
    }),
  );
  contactId = k.id;
  const d = await withTenant(admin, tenant, (c) =>
    createDeal(c, { tenantId: tenant, contactId, pipelineId, title, value: 1000, currency: 'CLP' }),
  );
  return d.id;
}

async function tarjeta(dealId: string) {
  const { items } = await withTenant(admin, tenant, (c) =>
    listDeals(c, tenant, { pipelineId }, AHORA),
  );
  const encontrada = items.find((i) => i.id === dealId);
  if (!encontrada) throw new Error(`la tarjeta ${dealId} no vino en el lote`);
  return encontrada;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('tarjeta-1302') RETURNING id"))
    .rows[0].id;
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
});

afterAll(async () => {
  await admin.query('DELETE FROM activities WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM deal_stage_history WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM deals WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM stages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM pipelines WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('la tarjeta dice qué hay que hacer y cuándo (#1302)', () => {
  it('sin actividad: la tarjeta lo dice con null, que no es un dato que falte', async () => {
    const id = await nuevoDeal('Sin nada');
    expect((await tarjeta(id)).proximaActividad).toBeNull();
  });

  it('una pendiente atrasada viene con los días de atraso', async () => {
    const id = await nuevoDeal('Atrasada');
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'llamada',
        title: 'Llamar para cerrar', dueAt: dias(-3),
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({
      title: 'Llamar para cerrar', estado: 'atrasada', dias: 3,
    });
  });

  it('la que vence HOY no es «atrasada 0 días»: es su propio estado', async () => {
    const id = await nuevoDeal('Hoy');
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'tarea',
        // Más temprano que AHORA el MISMO día: por reloj ya pasó, por
        // calendario es hoy. Restar instantes daría «atrasada»; es el
        // defecto que esta prueba fija.
        title: 'Mandar la propuesta', dueAt: new Date('2026-11-08T12:00:00Z'),
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({ estado: 'hoy', dias: null });
  });

  it('una futura trae cuántos días faltan', async () => {
    const id = await nuevoDeal('Futura');
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'reunion',
        title: 'Reunión', dueAt: dias(5),
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({ estado: 'proxima', dias: 5 });
  });

  it('una tarea sin fecha existe y se distingue de no tener ninguna', async () => {
    const id = await nuevoDeal('Sin fecha');
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'tarea', title: 'Revisar',
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({
      estado: 'sin_fecha', dias: null,
    });
  });

  it('trae UNA sola y es la más próxima, no la primera que encuentre', async () => {
    const id = await nuevoDeal('Varias');
    for (const [titulo, cuando] of [
      ['La lejana', dias(10)],
      ['La próxima', dias(1)],
      ['La del medio', dias(4)],
    ] as const) {
      await withTenant(admin, tenant, (c) =>
        createActivity(c, {
          tenantId: tenant, contactId, dealId: id, type: 'tarea', title: titulo, dueAt: cuando,
        }),
      );
    }
    expect((await tarjeta(id)).proximaActividad).toMatchObject({ title: 'La próxima', dias: 1 });
  });

  it('una sin fecha NO tapa a la que vence: el orden pone los nulos al final', async () => {
    const id = await nuevoDeal('Mezcla');
    // La sin fecha se crea PRIMERO, que es lo que la haría ganar por
    // `created_at` si el orden no pusiera los nulos al final.
    await withTenant(admin, tenant, (c) =>
      createActivity(c, { tenantId: tenant, contactId, dealId: id, type: 'tarea', title: 'Algún día' }),
    );
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'llamada', title: 'Mañana', dueAt: dias(1),
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({ title: 'Mañana' });
  });

  it('una completada deja de contar: el cupo de atención es de lo pendiente', async () => {
    const id = await nuevoDeal('Completada');
    const a = await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: id, type: 'tarea', title: 'Ya está', dueAt: dias(-1),
      }),
    );
    expect((await tarjeta(id)).proximaActividad).toMatchObject({ estado: 'atrasada' });
    await withTenant(admin, tenant, (c) =>
      completeActivity(c, { tenantId: tenant, activityId: a.id }),
    );
    expect((await tarjeta(id)).proximaActividad).toBeNull();
  });

  it('cada tarjeta trae la suya y no la de al lado', async () => {
    const mia = await nuevoDeal('La mía');
    const ajena = await nuevoDeal('La ajena');
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId, dealId: ajena, type: 'tarea',
        title: 'De la otra', dueAt: dias(2),
      }),
    );
    expect((await tarjeta(mia)).proximaActividad).toBeNull();
    expect((await tarjeta(ajena)).proximaActividad).toMatchObject({ title: 'De la otra' });
  });

  /**
   * El cruce por `deal_id` y no por `contact_id`, que es por donde cruza el
   * resto del módulo —las actividades cuelgan del contacto—.
   *
   * Hace falta un SEGUNDO embudo para verlo. La regla del producto es una
   * oportunidad abierta por contacto **y embudo**, así que dentro de un
   * embudo los dos cruces dan siempre lo mismo y ninguna prueba los
   * distingue. Con dos embudos, un mismo contacto tiene dos oportunidades
   * vivas, y una consulta que cruzara por contacto mostraría en la tarjeta de
   * una lo que hay que hacer con la otra.
   *
   * Lo comprobé: con el `deal_id` cambiado a `contact_id`, las otras nueve
   * pruebas pasan y solo esta se pone roja.
   */
  it('la tarjeta de un embudo no muestra lo que hay que hacer en el otro', async () => {
    const otroEmbudo = await withTenant(admin, tenant, (c) =>
      createPipeline(c, {
        tenantId: tenant,
        name: 'Postventa',
        stages: [
          { name: 'Abierta', type: 'open' },
          { name: 'Ganada', type: 'won' },
          { name: 'Perdida', type: 'lost' },
        ],
      }),
    );
    const enVentas = await nuevoDeal('En ventas');
    const elContacto = contactId;
    const enPostventa = await withTenant(admin, tenant, (c) =>
      createDeal(c, {
        tenantId: tenant, contactId: elContacto, pipelineId: otroEmbudo.pipeline.id,
        title: 'En postventa', value: 1000, currency: 'CLP',
      }),
    );
    await withTenant(admin, tenant, (c) =>
      createActivity(c, {
        tenantId: tenant, contactId: elContacto, dealId: enPostventa.id,
        type: 'tarea', title: 'Cosa de postventa', dueAt: dias(2),
      }),
    );
    // Mismo contacto, misma actividad pendiente, OTRO embudo: en el tablero de
    // Ventas esa tarjeta no tiene nada agendado.
    expect((await tarjeta(enVentas)).proximaActividad).toBeNull();
  });

  /**
   * Y la guarda que cierra el caso de adentro de un mismo embudo: una
   * actividad no puede apuntar a una oportunidad que no es de su contacto.
   * Queda fijada acá para que se sepa por qué la prueba de arriba necesita
   * dos embudos.
   */
  it('una actividad no puede apuntar a la oportunidad de otro contacto', async () => {
    await nuevoDeal('De una');
    const contactoDeUna = contactId;
    const deOtra = await nuevoDeal('De otra');
    await expect(
      withTenant(admin, tenant, (c) =>
        createActivity(c, {
          tenantId: tenant, contactId: contactoDeUna, dealId: deOtra,
          type: 'tarea', title: 'Cruzada', dueAt: dias(2),
        }),
      ),
    ).rejects.toThrow(/No encontramos esa oportunidad para este contacto/);
  });
});
