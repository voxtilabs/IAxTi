import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry } from '@iaxti/core';
import { assignRole } from '@iaxti/module-authorization';
import { receiveInbound } from '@iaxti/module-conversations';
import { createAgent, updateAgent } from '@iaxti/module-agents';
import { agendar, definirDisponibilidad } from '@iaxti/module-calendar';
import { processSuggest } from '../src/copilot';

/**
 * El cliente mueve SU hora, y solo la suya (#1283, ADR-0030).
 *
 * `calendar.reschedule` estuvo cerrada por ADR-0017 con un motivo concreto:
 * «mover o cancelar la hora de alguien que no lo pidió». Eso no se contesta
 * con una regla del prompt —un prompt que dice «mueve solo la cita de quien te
 * escribe» se incumple el día que el modelo alucina un UUID—, así que se
 * contesta con la firma: la herramienta NO recibe un id de cita.
 *
 * Esta prueba ejecuta la herramienta de verdad, con la base real, y mide las
 * dos mitades: que mueve la cita de quien escribe, y que la de al lado no se
 * toca ni pidiéndoselo.
 */
const recibidas: Array<
  Array<{ name: string; parameters: unknown; ejecutar: (a: Record<string, unknown>) => Promise<unknown> }>
> = [];
vi.mock('@iaxti/module-agents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@iaxti/module-agents')>();
  return {
    ...real,
    providerAvailable: () => true,
    autoRespondForInbound: async (_c: unknown, input: { tools?: unknown[] }) => {
      recibidas.push((input.tools ?? []) as never);
      return { action: 'assist' };
    },
  };
});

let pool: Pool;
let tenantId: string;
const duena = randomUUID();

const MARTES = '2030-06-11';
const H = (hhmm: string) => new Date(`${MARTES}T${hhmm}:00-04:00`);

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('mueve-su-hora') RETURNING id"))
    .rows[0].id;
  await withTenant(pool, tenantId, async (c) => {
    await assignRole(c, {
      tenantId,
      userId: duena,
      roleName: 'ADMIN',
      actor: 'prueba',
      createIfMissing: true,
    });
    const a = await createAgent(c, {
      tenantId,
      name: 'IAxTi',
      defaultMode: 'autonomous',
      allowedTools: ['calendar.get_slots', 'calendar.book', 'calendar.reschedule'],
      requestId: 'prueba',
    });
    await updateAgent(c, {
      tenantId,
      agentId: a.id,
      limits: { actua_como_user_id: duena },
      requestId: 'prueba',
    });
    // Martes de 09:00 a 12:00, bloques de 30, sin anticipación mínima que
    // estorbe: la prueba agenda en 2030.
    await definirDisponibilidad(c, {
      tenantId,
      ownerId: duena,
      weekday: 2,
      inicioMin: 9 * 60,
      finMin: 12 * 60,
      duracion: 30,
      respiro: 0,
    });
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

/** Hace escribir a alguien y devuelve las herramientas que recibió el modelo. */
async function escribe(telefono: string) {
  recibidas.length = 0;
  const conv = await withTenant(pool, tenantId, (c) =>
    receiveInbound(c, { tenantId, channel: 'whatsapp', phone: telefono, body: 'hola' }),
  );
  await processSuggest(
    pool,
    {
      tenantId,
      conversationId: conv.conversation.id,
      messageId: conv.message.id,
      requestId: `req-${telefono}`,
    },
    { registry: new ModuleRegistry().load() },
  );
  const tools = recibidas[0] ?? [];
  const mover = tools.find((t) => t.name === 'calendar.reschedule');
  return { contactId: conv.conversation.contactId!, tools, mover };
}

const tomar = (contactId: string, hhmm: string) =>
  withTenant(pool, tenantId, (c) =>
    agendar(c, {
      tenantId,
      contactId,
      ownerId: duena,
      inicio: H(hhmm),
      fin: new Date(H(hhmm).getTime() + 30 * 60_000),
      confirmada: true,
      actor: duena,
    }),
  );

const cuandoEs = async (id: string) =>
  (
    await withTenant(pool, tenantId, (c) =>
      c.query('SELECT starts_at FROM appointments WHERE id = $1', [id]),
    )
  ).rows[0].starts_at as Date;

describe('el cliente mueve su hora hablando con el agente (ADR-0030)', () => {
  it('la herramienta no tiene NINGÚN campo para nombrar una cita', async () => {
    // La garantía entera del ADR en una aserción: si mañana alguien le agrega
    // un `appointmentId` «para que sea más flexible», esto se pone rojo.
    const { mover } = await escribe('+56955550001');
    expect(mover, 'tiene que estar ofrecida').toBeDefined();
    const props = (mover!.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['inicio']);
  });

  it('mueve la hora de quien escribe', async () => {
    const { contactId, mover } = await escribe('+56955550002');
    const cita = await tomar(contactId, '09:00');
    const r = (await mover!.ejecutar({ inicio: H('10:00').toISOString() })) as {
      error?: string;
      datos?: unknown;
    };
    expect(r.error, 'no debería fallar').toBeUndefined();
    expect((await cuandoEs(cita.id)).toISOString()).toBe(H('10:00').toISOString());
  });

  it('a quien no tiene hora tomada se le dice, y no se mueve la de nadie', async () => {
    // La mitad que importa: la cita de otra persona existe, está a la vista
    // en la misma agenda, y pedir moverla no la mueve porque no hay forma de
    // nombrarla.
    const ajena = await escribe('+56955550003');
    const suya = await tomar(ajena.contactId, '11:00');

    const sinHora = await escribe('+56955550004');
    const r = (await sinHora.mover!.ejecutar({ inicio: H('11:30').toISOString() })) as {
      error?: string;
    };
    expect(r.error).toMatch(/no tiene ninguna hora tomada/i);
    expect((await cuandoEs(suya.id)).toISOString()).toBe(H('11:00').toISOString());
  });

  it('con dos horas tomadas no adivina: manda a escalar', async () => {
    const { contactId, mover } = await escribe('+56955550005');
    await tomar(contactId, '09:30');
    await tomar(contactId, '10:30');
    const r = (await mover!.ejecutar({ inicio: H('11:00').toISOString() })) as { error?: string };
    expect(r.error).toMatch(/2 horas tomadas/);
    expect(r.error).toMatch(/alguien del equipo/i);
  });

  it('no mueve a un horario que la agenda no ofrece', async () => {
    const { contactId, mover } = await escribe('+56955550006');
    const cita = await tomar(contactId, '09:00');
    const r = (await mover!.ejecutar({ inicio: H('03:00').toISOString() })) as { error?: string };
    expect(r.error).toMatch(/no está libre|no está disponible/i);
    expect((await cuandoEs(cita.id)).toISOString()).toBe(H('09:00').toISOString());
  });

  it('y la hora va con zona: una fecha a secas se rechaza', async () => {
    const { mover } = await escribe('+56955550007');
    const r = (await mover!.ejecutar({ inicio: '2030-06-11 10:00' })) as { error?: string };
    expect(r.error).toMatch(/con fecha y zona/i);
  });
});
