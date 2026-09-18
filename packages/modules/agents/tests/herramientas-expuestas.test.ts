import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { herramientasExpuestas } from '../application/herramientas-expuestas';
import type { DepsHerramientas } from '../application/herramientas';

/**
 * El cable entre el modelo y las herramientas (#240).
 *
 * `ejecutarHerramienta` ya existía y estaba probada; lo que no existía era
 * quién la llamara. Esto prueba que lo que se le ofrece al modelo es
 * exactamente lo permitido, y que pedir algo prohibido le devuelve un dato
 * —no una excepción— para que responda sin inventar.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const usuario = randomUUID();

const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const TODAS = [
  'conversations.get_context',
  'knowledge.search',
  'knowledge.get_product',
  'calendar.get_slots',
];

const deps = (over: Partial<DepsHerramientas> = {}): DepsHerramientas => ({
  actorPuede: async () => true,
  habilitadas: TODAS,
  getContext: async (id) => ({ conversationId: id }),
  buscarConocimiento: async (q) => ({ hits: [`sobre ${q}`] }),
  buscarProducto: async (q) => [{ nombre: q, precio: 1990 }],
  horariosLibres: async () => [{ hora: '09:00' }, { hora: '09:45' }, { hora: '10:30' }, { hora: '11:15' }],
  ...over,
});

const base = {
  tenantId: '',
  habilitadas: TODAS,
  actorUserId: usuario,
  conversationId: randomUUID(),
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('expuestas-test') RETURNING id");
  tenant = t.rows[0].id;
  base.tenantId = tenant;
});

afterAll(async () => {
  await admin.end();
});

describe('qué se le ofrece al modelo', () => {
  it('las cuatro de lectura, con su descripción y su esquema', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    expect(hs.map((h) => h.name).sort()).toEqual([...TODAS].sort());
    for (const h of hs) {
      expect(h.description.length).toBeGreaterThan(20);
      expect(h.parameters.type).toBe('object');
    }
  });

  it('una herramienta que sale hacia el cliente NO se ofrece, aunque esté configurada', async () => {
    const extra = ['conversations.send_reply', 'payments.create_link', 'calendar.book'];
    const hs = await en(async (c) =>
      herramientasExpuestas(
        c,
        { ...base, habilitadas: [...TODAS, ...extra] },
        deps({ habilitadas: [...TODAS, ...extra] }),
      ),
    );
    // El modelo no puede pedir lo que no se le ofrece: la puerta se cierra
    // antes, no en el momento de ejecutar.
    //
    // (Este test miraba `crm.create_deal`, que desde la ADR-0017 SÍ se
    // ofrece: queda adentro del negocio y se deshace. Las que siguen
    // cerradas son las que el cliente ve o que pisan trabajo ajeno.)
    for (const cerrada of extra) {
      expect(hs.map((h) => h.name), `se está ofreciendo "${cerrada}"`).not.toContain(cerrada);
    }
    expect(hs).toHaveLength(4);
  });

  it('un módulo apagado se lleva su herramienta', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(
        c,
        { ...base, habilitadas: ['knowledge.search'] },
        deps({ habilitadas: ['knowledge.search'] }),
      ),
    );
    expect(hs.map((h) => h.name)).toEqual(['knowledge.search']);
  });

  it('sin persona identificada no se ofrece ninguna', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(c, { ...base, actorUserId: null }, deps()),
    );
    // Una llamada sin identidad no se puede verificar contra ningún
    // permiso: mejor ninguna herramienta que una sin dueño.
    expect(hs).toEqual([]);
  });
});

describe('cuando el modelo la pide', () => {
  it('ejecuta y devuelve los datos', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const buscar = hs.find((h) => h.name === 'knowledge.search')!;
    const r = await en(async () => buscar.ejecutar({ query: 'garantía' }));
    expect(r).toEqual({ hits: ['sobre garantía'] });
  });

  it('los horarios llegan de a tres, no de a cuatro', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const agenda = hs.find((h) => h.name === 'calendar.get_slots')!;
    const r = (await en(async () => agenda.ejecutar({ dia: '2026-09-21' }))) as unknown[];
    expect(r).toHaveLength(3);
  });

  it('sin el permiso de la persona, el modelo recibe el motivo — no una excepción', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(c, base, deps({ actorPuede: async () => false })),
    );
    const buscar = hs.find((h) => h.name === 'knowledge.search')!;
    const r = (await en(async () => buscar.ejecutar({ query: 'precios' }))) as { error?: string };
    // Devolver el motivo es lo que evita que invente: si esto lanzara, el
    // modelo se quedaría sin respuesta y llenaría el hueco solo.
    expect(r.error).toMatch(/no tiene el permiso "knowledge.read"/);
  });

  it('un argumento que falta también vuelve como dato', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const agenda = hs.find((h) => h.name === 'calendar.get_slots')!;
    const r = (await en(async () => agenda.ejecutar({ dia: 'el martes' }))) as { error?: string };
    expect(r.error).toMatch(/AAAA-MM-DD/);
  });

  it('cada ejecución queda en el libro como acción de la IA', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const buscar = hs.find((h) => h.name === 'knowledge.search')!;
    await en(async () => buscar.ejecutar({ query: 'despacho' }));

    const r = await admin.query(
      `SELECT actor, actor_kind, action, result FROM audit_log
        WHERE tenant_id = $1 AND action = 'agent.tool.knowledge.search'
        ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(r.rows[0]).toMatchObject({
      actor: usuario, // la persona a cuyo nombre actuó
      actor_kind: 'agent', // pero fue la IA: si dijera 'user' no se distinguiría
      result: 'ok',
    });
  });
});
