import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { herramientasExpuestas } from '../application/herramientas-expuestas';
import {
  HERRAMIENTAS_QUE_ESCRIBEN,
  HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS,
  type DepsHerramientas,
} from '../application/herramientas';

/**
 * Qué puede escribir la IA (#240, ADR-0017).
 *
 * El criterio: ¿lo ve el cliente? y ¿se puede deshacer? Solo pasan las que
 * quedan adentro del negocio y tienen un estado que las anula. Lo que se
 * prueba acá es sobre todo lo que NO puede: una IA que agenda, cobra o
 * escribe al cliente es otra cosa distinta de la que decidimos.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const usuario = randomUUID();
const contacto = randomUUID();

const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const TODAS = [
  ...Object.keys(HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS),
  'conversations.get_context',
];

const creadas: unknown[] = [];

const deps = (over: Partial<DepsHerramientas> = {}): DepsHerramientas => ({
  actorPuede: async () => true,
  habilitadas: TODAS,
  getContext: async (id) => ({ conversationId: id }),
  buscarConocimiento: async () => ({ hits: [] }),
  buscarProducto: async () => [],
  contactoDeLaConversacion: async () => contacto,
  crearActividad: async (i) => {
    creadas.push({ tipo: 'actividad', ...i });
    return { id: randomUUID(), ...i };
  },
  crearOportunidad: async (i) => {
    creadas.push({ tipo: 'oportunidad', ...i });
    return { id: randomUUID(), ...i };
  },
  ...over,
});

const base = { tenantId: '', habilitadas: TODAS, actorUserId: usuario, conversationId: randomUUID() };

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('escriben-test') RETURNING id");
  tenant = t.rows[0].id;
  base.tenantId = tenant;
});

afterAll(async () => {
  await admin.end();
});

describe('lo que la IA NO puede hacer', () => {
  it('las siete cerradas no se le ofrecen siquiera', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(
        c,
        { ...base, habilitadas: [...TODAS, ...HERRAMIENTAS_QUE_ESCRIBEN] },
        deps({ habilitadas: [...TODAS, ...HERRAMIENTAS_QUE_ESCRIBEN] }),
      ),
    );
    const nombres = hs.map((h) => h.name);
    for (const cerrada of HERRAMIENTAS_QUE_ESCRIBEN) {
      expect(nombres, `se le está ofreciendo "${cerrada}"`).not.toContain(cerrada);
    }
  });

  it('agendar, cobrar, responder y cerrar siguen fuera', () => {
    // La lista explícita, para que abrir una sea una decisión y no un
    // renombre. Si alguien saca una de acá, este test lo dice.
    expect([...HERRAMIENTAS_QUE_ESCRIBEN].sort()).toEqual(
      [
        'calendar.book',
        'calendar.cancel',
        'calendar.reschedule',
        'conversations.send_reply',
        'conversations.set_state',
        'crm.update_deal',
        'payments.create_link',
      ].sort(),
    );
  });

  it('solo dos escriben, y son las que se deshacen', () => {
    expect(Object.keys(HERRAMIENTAS_QUE_ESCRIBEN_HABILITADAS).sort()).toEqual([
      'crm.create_activity',
      'crm.create_deal',
    ]);
  });
});

describe('lo que sí puede', () => {
  it('deja una nota en la ficha del contacto de ESTA conversación', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const nota = hs.find((h) => h.name === 'crm.create_activity')!;
    await en(async () => nota.ejecutar({ title: 'Pidió precio del corte' }));

    const ultima = creadas.at(-1) as { tipo: string; contactId: string; type: string };
    expect(ultima.tipo).toBe('actividad');
    // El contacto NO lo elige el modelo: sale de la conversación.
    expect(ultima.contactId).toBe(contacto);
    expect(ultima.type).toBe('nota');
  });

  it('crea la oportunidad sin elegir etapa ni inventar monto', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const deal = hs.find((h) => h.name === 'crm.create_deal')!;
    await en(async () => deal.ejecutar({ title: 'Corte y color' }));

    const ultima = creadas.at(-1) as Record<string, unknown>;
    expect(ultima.tipo).toBe('oportunidad');
    expect(ultima.value).toBeUndefined(); // sin monto si el cliente no lo dijo
    expect('stageId' in ultima).toBe(false); // la etapa no se elige
  });

  it('un monto que no es número se rechaza en vez de guardarse raro', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const deal = hs.find((h) => h.name === 'crm.create_deal')!;
    const r = (await en(async () => deal.ejecutar({ title: 'X', value: 'como veinte lucas' }))) as {
      error?: string;
    };
    expect(r.error).toMatch(/número/);
  });
});

describe('las guardas', () => {
  it('una escritura por generación: la segunda recibe el motivo', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const deal = hs.find((h) => h.name === 'crm.create_deal')!;
    const nota = hs.find((h) => h.name === 'crm.create_activity')!;

    await en(async () => deal.ejecutar({ title: 'Primera' }));
    const segunda = (await en(async () => deal.ejecutar({ title: 'Segunda' }))) as { error?: string };
    expect(segunda.error).toMatch(/solo se permite una escritura/);

    // Y tampoco otra distinta: el tope es por generación, no por herramienta.
    const otra = (await en(async () => nota.ejecutar({ title: 'Y una nota' }))) as { error?: string };
    expect(otra.error).toMatch(/solo se permite una escritura/);
  });

  it('una llamada rechazada por permiso NO gasta el turno', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(c, base, deps({ actorPuede: async () => false })),
    );
    const deal = hs.find((h) => h.name === 'crm.create_deal')!;
    const primera = (await en(async () => deal.ejecutar({ title: 'Sin permiso' }))) as { error?: string };
    expect(primera.error).toMatch(/no tiene el permiso "crm.deals.create"/);

    // Si gastara el turno, un permiso faltante dejaría al modelo sin poder
    // hacer nada más en esa respuesta — castigo doble por un solo problema.
    const conPermiso = await en(async (c) => herramientasExpuestas(c, base, deps()));
    const r = await en(async () =>
      conPermiso.find((h) => h.name === 'crm.create_deal')!.ejecutar({ title: 'Con permiso' }),
    );
    expect((r as { error?: string }).error).toBeUndefined();
  });

  it('sin contacto en la conversación no se crea nada a ciegas', async () => {
    const hs = await en(async (c) =>
      herramientasExpuestas(c, base, deps({ contactoDeLaConversacion: async () => null })),
    );
    const r = (await en(async () =>
      hs.find((h) => h.name === 'crm.create_deal')!.ejecutar({ title: 'A quién' }),
    )) as { error?: string };
    expect(r.error).toMatch(/de qué contacto/);
  });

  it('cada escritura queda en el libro como acción de la IA', async () => {
    const hs = await en(async (c) => herramientasExpuestas(c, base, deps()));
    await en(async () => hs.find((h) => h.name === 'crm.create_activity')!.ejecutar({ title: 'Con rastro' }));

    const r = await admin.query(
      `SELECT actor, actor_kind, result FROM audit_log
        WHERE tenant_id = $1 AND action = 'agent.tool.crm.create_activity'
        ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(r.rows[0]).toMatchObject({ actor: usuario, actor_kind: 'agent', result: 'ok' });
  });
});
