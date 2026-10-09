import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  VENTANA_ATRIBUCION_DIAS,
  abrirIntento,
  casiLogrados,
  intentosLogrados,
  marcarLogrado,
  marcarLogradoPorElAgente,
  marcarPerdido,
  tasaDeObjetivo,
} from '../application/objetivo-medido';
import { createAgent } from '../application/agents';
import type { Agent } from '../application/agents';

/**
 * El objetivo, auditable (#701).
 *
 * `achieved_event` y `closed_at` se escribían desde #319 y ningún `SELECT` las
 * devolvía. `tasaDeObjetivo` es la métrica con la que se defiende el producto
 * frente al cliente que paga, y estas dos columnas son las que la hacen
 * revisable: QUÉ evento contó como logro, y CUÁNDO se cerró el intento.
 *
 * Y había un hueco peor que no leerlas: `closed_at` se estampaba SOLO al
 * perder. Un intento logrado quedaba con esa columna en NULL para siempre.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agente: Agent;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('objetivo-auditable') RETURNING id")).rows[0].id;
  agente = await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', objetivo: 'agendar', actor: 'test' }),
  );
});

afterAll(async () => {
  for (const t of ['agent_goal_attempts', 'agents', 'outbox']) {
    await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

/** Un intento abierto, opcionalmente con la fecha de inicio corrida atrás. */
async function abrir(haceDias = 0): Promise<{ conversationId: string; contactId: string }> {
  const conversationId = randomUUID();
  const contactId = randomUUID();
  await withTenant(admin, tenant, (c) =>
    abrirIntento(c, { tenantId: tenant, conversationId, contactId, agentId: agente.id, objetivo: 'agendar' }),
  );
  if (haceDias > 0) {
    await admin.query(
      `UPDATE agent_goal_attempts SET started_at = now() - make_interval(days => $2)
        WHERE conversation_id = $1`,
      [conversationId, haceDias],
    );
  }
  return { conversationId, contactId };
}

const fila = async (conversationId: string) =>
  (
    await admin.query(
      `SELECT outcome, closed_at, achieved_at, achieved_event,
              fuera_de_ventana_at, fuera_de_ventana_event
         FROM agent_goal_attempts WHERE conversation_id = $1`,
      [conversationId],
    )
  ).rows[0];

describe('closed_at se estampa en los TRES cierres (#701)', () => {
  it('cuando lo logra el agente', async () => {
    // Antes solo se estampaba al perder: un logro quedaba con closed_at en
    // NULL para siempre, y «cuánto tarda en lograrse» no se podía calcular.
    const { conversationId } = await abrir();
    await withTenant(admin, tenant, (c) =>
      marcarLogradoPorElAgente(c, {
        tenantId: tenant, conversationId, evento: 'appointment.created', referencia: randomUUID(),
      }),
    );
    const f = await fila(conversationId);
    expect(f.outcome).toBe('logrado');
    expect(f.closed_at, 'un logro sin closed_at se ve igual que un intento abierto').toBeTruthy();
    expect(f.achieved_event).toBe('appointment.created');
  });

  it('cuando lo cierra una persona', async () => {
    const { conversationId, contactId } = await abrir();
    await withTenant(admin, tenant, (c) =>
      marcarLogrado(c, { tenantId: tenant, contactId, evento: 'appointment.created', referencia: null }),
    );
    const f = await fila(conversationId);
    expect(f.outcome).toBe('logrado');
    expect(f.closed_at).toBeTruthy();
    // El mismo instante que achieved_at: el intento se cierra al lograrse.
    expect(new Date(f.closed_at).getTime()).toBe(new Date(f.achieved_at).getTime());
  });

  it('y cuando se pierde, como ya era', async () => {
    const { conversationId } = await abrir();
    await withTenant(admin, tenant, (c) => marcarPerdido(c, { tenantId: tenant, conversationId }));
    const f = await fila(conversationId);
    expect(f.outcome).toBe('perdido');
    expect(f.closed_at).toBeTruthy();
    expect(f.achieved_at, 'perdido no tiene logro').toBeNull();
  });

  it('un intento abierto no tiene closed_at: así se distingue', async () => {
    const { conversationId } = await abrir();
    const f = await fila(conversationId);
    expect(f.outcome).toBe('pendiente');
    expect(f.closed_at).toBeNull();
  });
});

describe('la tasa trae su respaldo (#701)', () => {
  it('el tiempo hasta el logro sale de closed_at, no de una resta contra ahora', async () => {
    // Restar contra `now()` daría un número que crece solo con el tiempo
    // aunque no pase nada: el martes diría 2 h y el viernes 74 h, por el mismo
    // logro.
    const { conversationId } = await abrir(0);
    await admin.query(
      `UPDATE agent_goal_attempts SET started_at = now() - interval '6 hours'
        WHERE conversation_id = $1`,
      [conversationId],
    );
    await withTenant(admin, tenant, (c) =>
      marcarLogradoPorElAgente(c, {
        tenantId: tenant, conversationId, evento: 'deal.created', referencia: null,
      }),
    );
    const tasa = await withTenant(admin, tenant, (c) => tasaDeObjetivo(c, tenant, agente.id));
    expect(tasa.horasHastaElLogro).not.toBeNull();
    expect(tasa.horasHastaElLogro!).toBeGreaterThan(0);
  });

  it('dice qué eventos contaron como logro, con su cuenta', async () => {
    // «45 %» sin poder abrir los casos es un número que hay que creer. Y si el
    // catálogo de eventos de éxito cambia, esto es lo único que dice cuáles se
    // midieron con la regla vieja.
    const tasa = await withTenant(admin, tenant, (c) => tasaDeObjetivo(c, tenant, agente.id));
    const eventos = Object.fromEntries(tasa.porEvento.map((e) => [e.evento, e.n]));
    expect(eventos['appointment.created']).toBeGreaterThanOrEqual(2);
    expect(eventos['deal.created']).toBeGreaterThanOrEqual(1);
    expect(tasa.porEvento.map((e) => e.n)).toEqual([...tasa.porEvento.map((e) => e.n)].sort((a, b) => b - a));
  });

  it('los intentos logrados se pueden listar con el evento que los logró', async () => {
    const logrados = await withTenant(admin, tenant, (c) => intentosLogrados(c, tenant, agente.id));
    expect(logrados.length).toBeGreaterThanOrEqual(3);
    expect(logrados.every((l) => l.evento !== null)).toBe(true);
    expect(logrados.every((l) => l.closedAt !== null)).toBe(true);
    expect(logrados.some((l) => l.atribucion === 'agente')).toBe(true);
    expect(logrados.some((l) => l.atribucion === 'asistida')).toBe(true);
    // Las horas salen de la diferencia guardada, no de un cálculo contra ahora.
    expect(logrados.every((l) => l.horas !== null && l.horas >= 0)).toBe(true);
  });

  it('sin logros, el tiempo es null y no cero', async () => {
    const otro = (await admin.query("INSERT INTO tenants (name) VALUES ('sin-logros') RETURNING id")).rows[0].id;
    const ag = await withTenant(admin, otro, (c) =>
      createAgent(c, { tenantId: otro, name: 'Nueva', objetivo: 'vender', actor: 'test' }),
    );
    const conversationId = randomUUID();
    await withTenant(admin, otro, (c) =>
      abrirIntento(c, {
        tenantId: otro, conversationId, contactId: randomUUID(), agentId: ag.id, objetivo: 'vender',
      }),
    );
    const tasa = await withTenant(admin, otro, (c) => tasaDeObjetivo(c, otro, ag.id));
    expect(tasa.horasHastaElLogro).toBeNull();
    expect(tasa.porEvento).toEqual([]);
    // El tenant NO se borra: `audit_log` es append-only y lo referencia. Las
    // filas de prueba quedan, como en el resto de las suites.
    for (const t of ['agent_goal_attempts', 'agents', 'outbox']) {
      await admin.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [otro]);
    }
  });
});

describe('lo que llegó fuera de la ventana se puede ver (#701)', () => {
  it('no cuenta, y queda anotado por qué no contó', async () => {
    // Criterio 4. Sin esto, «no contó» y «no pasó» se ven idénticos — y es la
    // pregunta del dueño frente a un intento perdido de un cliente que
    // terminó comprando.
    const { conversationId, contactId } = await abrir(VENTANA_ATRIBUCION_DIAS + 2);
    const antes = await withTenant(admin, tenant, (c) => tasaDeObjetivo(c, tenant, agente.id));

    const cerrados = await withTenant(admin, tenant, (c) =>
      marcarLogrado(c, { tenantId: tenant, contactId, evento: 'appointment.created', referencia: null }),
    );
    expect(cerrados, 'fuera de la ventana no cierra el intento').toBe(0);

    const f = await fila(conversationId);
    expect(f.outcome, 'sigue abierto: lo que llegó no lo logró').toBe('pendiente');
    expect(f.fuera_de_ventana_at).toBeTruthy();
    expect(f.fuera_de_ventana_event).toBe('appointment.created');

    const despues = await withTenant(admin, tenant, (c) => tasaDeObjetivo(c, tenant, agente.id));
    expect(despues.porElAgente, 'la ventana no se movió').toBe(antes.porElAgente);
    expect(despues.asistidos).toBe(antes.asistidos);
    expect(despues.fueraDeVentana).toBe(antes.fueraDeVentana + 1);
  });

  it('el casi-logro dice cuántos días después llegó', async () => {
    const casi = await withTenant(admin, tenant, (c) => casiLogrados(c, tenant, agente.id));
    expect(casi.length).toBeGreaterThanOrEqual(1);
    expect(casi[0].diasDespues).toBeGreaterThan(VENTANA_ATRIBUCION_DIAS);
    expect(casi[0].evento).toBe('appointment.created');
    expect(casi[0].outcome).toBe('pendiente');
  });

  it('dentro de la ventana sí cuenta y NO se marca como tardío', async () => {
    // El control del caso anterior: si todo se marcara tardío, la marca no
    // diría nada.
    const { conversationId, contactId } = await abrir(1);
    const cerrados = await withTenant(admin, tenant, (c) =>
      marcarLogrado(c, { tenantId: tenant, contactId, evento: 'appointment.created', referencia: null }),
    );
    expect(cerrados).toBe(1);
    const f = await fila(conversationId);
    expect(f.outcome).toBe('logrado');
    expect(f.fuera_de_ventana_at).toBeNull();
  });
});
