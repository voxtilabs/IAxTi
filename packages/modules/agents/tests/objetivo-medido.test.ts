import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { EventEnvelope } from '@iaxti/core';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  VENTANA_ATRIBUCION_DIAS,
  abrirIntento,
  eventosDeExito,
  marcarLogrado,
  marcarLogradoPorElAgente,
  marcarPerdido,
  objetivoConsumers,
  tasaDeObjetivo,
} from '../application/objetivo-medido';
import { createAgent } from '../application/agents';
import type { Agent } from '../application/agents';

// ¿El agente logra su objetivo? (#319) Lo que se mide acá no es si el número
// sale: es que NO exagere el mérito del agente.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agente: Agent;

async function emitir(name: string, payload: Record<string, unknown>) {
  const consumer = objetivoConsumers().find((c) => c.event === name);
  if (!consumer) throw new Error(`nadie escucha ${name}`);
  const client = await admin.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenant]);
    await consumer.handler(
      { id: 1, name, tenantId: tenant, payload, actor: 'system', version: 1, occurredAt: new Date() } as unknown as EventEnvelope,
      client,
    );
  } finally {
    client.release();
  }
}

async function intento(conversationId: string): Promise<Record<string, unknown>> {
  const r = await admin.query(
    'SELECT * FROM agent_goal_attempts WHERE tenant_id = $1 AND conversation_id = $2',
    [tenant, conversationId],
  );
  return r.rows[0];
}

/** Abre un intento para un contacto nuevo. Devuelve conversación y contacto. */
async function nuevoIntento(
  objetivo: 'agendar' | 'vender',
  opts: { hace?: number } = {},
): Promise<{ conversationId: string; contactId: string }> {
  const conversationId = randomUUID();
  const contactId = randomUUID();
  await withTenant(admin, tenant, (c: PoolClient) =>
    abrirIntento(c, {
      tenantId: tenant,
      conversationId,
      contactId,
      agentId: agente.id,
      objetivo,
      objetivoDetalle: 'una visita',
    }),
  );
  if (opts.hace) {
    await admin.query(
      `UPDATE agent_goal_attempts SET started_at = now() - ($3 || ' days')::interval
        WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenant, conversationId, String(opts.hace)],
    );
  }
  return { conversationId, contactId };
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('objetivo-medido') RETURNING id");
  tenant = t.rows[0].id;
  agente = await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', objetivo: 'agendar', actor: 'test' }),
  );
});

afterAll(async () => {
  for (const tabla of ['agent_goal_attempts', 'agents', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('abrir el intento', () => {
  it('se abre una vez: lo que importa es cuándo EMPEZÓ, no la última vez', async () => {
    const { conversationId, contactId } = await nuevoIntento('agendar');
    const primero = await intento(conversationId);
    expect(primero.outcome).toBe('pendiente');
    expect(primero.atribucion).toBeNull();

    // El agente vuelve a trabajar la misma conversación: no se pisa nada.
    await withTenant(admin, tenant, (c) =>
      abrirIntento(c, {
        tenantId: tenant,
        conversationId,
        contactId,
        agentId: agente.id,
        objetivo: 'vender',
        objetivoDetalle: 'otra cosa',
      }),
    );
    const despues = await intento(conversationId);
    expect(despues.objetivo).toBe('agendar');
    expect(despues.started_at).toEqual(primero.started_at);
  });
});

describe('la atribución no exagera el mérito del agente', () => {
  it('la tool del agente es un HECHO: queda como "agente"', async () => {
    const { conversationId } = await nuevoIntento('vender');
    const dealId = randomUUID();
    const marcado = await withTenant(admin, tenant, (c) =>
      marcarLogradoPorElAgente(c, {
        tenantId: tenant,
        conversationId,
        evento: 'deal.created',
        referencia: dealId,
      }),
    );
    expect(marcado).toBe(true);
    const i = await intento(conversationId);
    expect(i.outcome).toBe('logrado');
    expect(i.atribucion).toBe('agente');
    expect(i.achieved_ref).toBe(dealId);
  });

  it('una persona cerrando lo que el agente preparó es "asistida", no "agente"', async () => {
    // Es el caso de agendar: la IA ofrece horarios y una persona toma la
    // hora (ADR-0017). Buen resultado, pero no lo hizo el agente.
    const { conversationId, contactId } = await nuevoIntento('agendar');
    await emitir('appointment.created', { appointmentId: randomUUID(), contactId });
    const i = await intento(conversationId);
    expect(i.outcome).toBe('logrado');
    expect(i.atribucion).toBe('asistida');
  });

  it('el evento que llega después NO vuelve a contar lo que ya hizo el agente', async () => {
    // El orden no importa: la tool marca en su transacción, y el evento que
    // la misma operación publica encuentra el intento ya cerrado.
    const { conversationId, contactId } = await nuevoIntento('vender');
    await withTenant(admin, tenant, (c) =>
      marcarLogradoPorElAgente(c, { tenantId: tenant, conversationId, evento: 'deal.created', referencia: null }),
    );
    await emitir('deal.created', { dealId: randomUUID(), contactId });
    expect((await intento(conversationId)).atribucion).toBe('agente');
  });

  it('el evento repetido no cambia nada la segunda vez', async () => {
    const { conversationId, contactId } = await nuevoIntento('agendar');
    const appointmentId = randomUUID();
    await emitir('appointment.created', { appointmentId, contactId });
    const primera = await intento(conversationId);
    await emitir('appointment.created', { appointmentId, contactId });
    expect((await intento(conversationId)).achieved_at).toEqual(primera.achieved_at);
  });

  it('fuera de la ventana no es mérito de nadie', async () => {
    // El dueño llamó por teléfono una semana después. Contarlo sería inflar
    // el número con algo que el agente no tuvo nada que ver.
    const { conversationId, contactId } = await nuevoIntento('agendar', {
      hace: VENTANA_ATRIBUCION_DIAS + 2,
    });
    await emitir('appointment.created', { appointmentId: randomUUID(), contactId });
    expect((await intento(conversationId)).outcome).toBe('pendiente');
  });

  it('un evento que no es el éxito de ESE objetivo no lo cierra', async () => {
    // Mismo contacto, otra cosa: una cita no cierra un intento de vender.
    const { conversationId, contactId } = await nuevoIntento('vender');
    await emitir('appointment.created', { appointmentId: randomUUID(), contactId });
    expect((await intento(conversationId)).outcome).toBe('pendiente');
  });

  it('los eventos de éxito salen del catálogo, no de una lista paralela', () => {
    const eventos = eventosDeExito();
    expect(eventos).toContain('appointment.created');
    expect(eventos).toContain('deal.created');
    // `informar` y `calificar` no declaran evento: no inventan uno.
    expect(objetivoConsumers().filter((c) => c.event !== 'conversation.state_changed')).toHaveLength(
      eventos.length,
    );
  });
});

describe('el denominador es honesto', () => {
  it('la conversación resuelta sin lograrlo cuenta como perdida', async () => {
    const { conversationId } = await nuevoIntento('agendar');
    await emitir('conversation.state_changed', { conversationId, from: 'open', to: 'resolved' });
    expect((await intento(conversationId)).outcome).toBe('perdido');
  });

  it("un estado que no es terminal no cierra nada", async () => {
    const { conversationId } = await nuevoIntento('agendar');
    await emitir('conversation.state_changed', { conversationId, from: 'new', to: 'open' });
    expect((await intento(conversationId)).outcome).toBe('pendiente');
    // Y lo ya logrado no se pierde por resolverse después: resolver una
    // conversación es lo normal DESPUÉS de conseguir la hora.
    await withTenant(admin, tenant, (c) =>
      marcarLogradoPorElAgente(c, { tenantId: tenant, conversationId, evento: 'deal.created', referencia: null }),
    );
    await withTenant(admin, tenant, (c) => marcarPerdido(c, { tenantId: tenant, conversationId }));
    expect((await intento(conversationId)).outcome).toBe('logrado');
  });
});

describe('las dos tasas van SEPARADAS', () => {
  it('nunca se suman en un solo número', async () => {
    const t2 = await admin.query("INSERT INTO tenants (name) VALUES ('tasas') RETURNING id");
    const otro = t2.rows[0].id;
    const ag = await withTenant(admin, otro, (c) =>
      createAgent(c, { tenantId: otro, name: 'Medida', objetivo: 'agendar', actor: 'test' }),
    );
    const abrir = async () => {
      const conversationId = randomUUID();
      const contactId = randomUUID();
      await withTenant(admin, otro, (c) =>
        abrirIntento(c, { tenantId: otro, conversationId, contactId, agentId: ag.id, objetivo: 'agendar' }),
      );
      return { conversationId, contactId };
    };
    // 1 del agente, 2 asistidos, 1 perdido, 1 todavía abierto.
    const a = await abrir();
    await withTenant(admin, otro, (c) =>
      marcarLogradoPorElAgente(c, { tenantId: otro, conversationId: a.conversationId, evento: 'x', referencia: null }),
    );
    for (let i = 0; i < 2; i++) {
      const b = await abrir();
      await withTenant(admin, otro, (c) =>
        marcarLogrado(c, { tenantId: otro, contactId: b.contactId, evento: 'appointment.created', referencia: null }),
      );
    }
    const d = await abrir();
    await withTenant(admin, otro, (c) => marcarPerdido(c, { tenantId: otro, conversationId: d.conversationId }));
    await abrir();

    const tasa = await withTenant(admin, otro, (c) => tasaDeObjetivo(c, otro, ag.id));
    expect(tasa.cerrados).toBe(4);
    expect(tasa.pendientes).toBe(1);
    expect(tasa.porElAgente).toBe(1);
    expect(tasa.asistidos).toBe(2);
    expect(tasa.perdidos).toBe(1);
    // Lo que se puede defender sin asteriscos: 1 de 4.
    expect(tasa.tasaDelAgente).toBe(0.25);
    // Y la otra, aparte: 3 de 4. Un solo número de 0.75 haría creer que el
    // agente agendó tres veces, y agendó una.
    expect(tasa.tasaConAsistencia).toBe(0.75);
    for (const t of ['agent_goal_attempts', 'agents', 'outbox']) {
      await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [otro]);
    }
  });

  it('sin conversaciones terminadas la tasa es null, no cero', async () => {
    const t3 = await admin.query("INSERT INTO tenants (name) VALUES ('sin-datos') RETURNING id");
    const otro = t3.rows[0].id;
    const ag = await withTenant(admin, otro, (c) =>
      createAgent(c, { tenantId: otro, name: 'Nueva', objetivo: 'vender', actor: 'test' }),
    );
    // "Todavía no se sabe" y "le va pésimo" son cosas distintas, y con un 0
    // redondeado se ven igual.
    const vacia = await withTenant(admin, otro, (c) => tasaDeObjetivo(c, otro, ag.id));
    expect(vacia.tasaDelAgente).toBeNull();
    expect(vacia.cerrados).toBe(0);
    for (const t of ['agents', 'outbox']) {
      await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [otro]);
    }
  });
});
