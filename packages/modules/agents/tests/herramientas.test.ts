import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ejecutarHerramienta, type DepsHerramientas } from '../application/herramientas';

/**
 * Las herramientas de la IA (#240). Lo que se prueba acá es sobre todo lo
 * que NO puede hacer: una herramienta que se ejecuta con más permisos que
 * la persona que la disparó es una escalada de privilegios con buena cara.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const usuario = randomUUID();

// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

const deps = (over: Partial<DepsHerramientas> = {}): DepsHerramientas => ({
  actorPuede: async () => true,
  habilitadas: [
    'conversations.get_context',
    'knowledge.search',
    'knowledge.get_product',
    'calendar.get_slots',
  ],
  getContext: async (id) => ({ conversationId: id, mensajes: ['hola'] }),
  buscarConocimiento: async (q) => ({ hits: [`respuesta a ${q}`] }),
  buscarProducto: async (q) => [{ nombre: q, precio: 1990 }],
  horariosLibres: async () => [
    { hora: '09:00' },
    { hora: '09:45' },
    { hora: '10:30' },
    { hora: '11:15' },
    { hora: '12:00' },
  ],
  ...over,
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('herramientas-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('herramientas de lectura', () => {
  it('buscan en el conocimiento y traen el contexto', async () => {
    const ctx = await en((c) =>
      ejecutarHerramienta(
        c,
        {
          tenantId: tenant,
          tool: 'conversations.get_context',
          args: { conversationId: 'conv-1' },
          actorUserId: usuario,
        },
        deps(),
      ),
    );
    expect(ctx.ok).toBe(true);
    expect(ctx.datos).toMatchObject({ conversationId: 'conv-1' });

    const busqueda = await en((c) =>
      ejecutarHerramienta(
        c,
        { tenantId: tenant, tool: 'knowledge.search', args: { query: 'horarios' }, actorUserId: usuario },
        deps(),
      ),
    );
    expect(busqueda.ok).toBe(true);
  });

  it('ofrece TRES horarios como mucho: en un chat una lista larga no se lee', async () => {
    const res = await en((c) =>
      ejecutarHerramienta(
        c,
        {
          tenantId: tenant,
          tool: 'calendar.get_slots',
          args: { dia: '2027-03-01' },
          actorUserId: usuario,
        },
        deps(),
      ),
    );
    expect(res.ok).toBe(true);
    expect(res.datos).toHaveLength(3);
  });

  it('un día mal escrito se rechaza antes de tocar la agenda', async () => {
    const res = await en((c) =>
      ejecutarHerramienta(
        c,
        { tenantId: tenant, tool: 'calendar.get_slots', args: { dia: 'mañana' }, actorUserId: usuario },
        deps(),
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('AAAA-MM-DD');
  });

  it('cada ejecución queda en el libro como acción de la IA, no de la persona', async () => {
    // Se busca una ejecución concreta y no "la última": el orden de los
    // tests no puede decidir qué fila mira esta afirmación.
    const r = await admin.query(
      `SELECT actor, actor_kind, action, result FROM audit_log
        WHERE tenant_id = $1 AND action = 'agent.tool.knowledge.search' AND result = 'ok'
        ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    // El usuario a cuyo nombre actuó, pero marcada como 'agent': si se
    // registrara como si la hubiera hecho la persona, después no se podría
    // distinguir.
    expect(r.rows[0]).toMatchObject({ actor: usuario, actor_kind: 'agent', result: 'ok' });
  });
});

describe('lo que NO puede hacer', () => {
  it('no hace lo que la persona no podría', async () => {
    const res = await en((c) =>
      ejecutarHerramienta(
        c,
        { tenantId: tenant, tool: 'knowledge.search', args: { query: 'precios' }, actorUserId: usuario },
        deps({ actorPuede: async () => false }),
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no tiene el permiso "knowledge.read"');
  });

  it('no ejecuta una herramienta que el agente no tiene habilitada', async () => {
    const res = await en((c) =>
      ejecutarHerramienta(
        c,
        { tenantId: tenant, tool: 'knowledge.search', args: { query: 'x' }, actorUserId: usuario },
        deps({ habilitadas: ['conversations.get_context'] }),
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no está habilitada');
  });

  it('no escribe lo que el cliente ve, y explica por qué (ADR-0017)', async () => {
    // `calendar.book` entra acá a propósito: ofrecer horarios es leer,
    // tomarlos es escribir.
    // `crm.create_deal` salió de esta lista con la ADR-0017: queda adentro
    // del negocio y se marca perdida, así que la IA sí la puede crear. Las
    // que siguen acá son las que el cliente ve.
    for (const tool of ['conversations.send_reply', 'payments.create_link', 'calendar.book']) {
      const res = await en((c) =>
        ejecutarHerramienta(
          c,
          { tenantId: tenant, tool, args: {}, actorUserId: usuario },
          deps({ habilitadas: [tool] }),
        ),
      );
      expect(res.ok).toBe(false);
      expect(res.error).toContain('ADR-0017');
    }
  });

  it('una herramienta inventada no existe', async () => {
    const res = await en((c) =>
      ejecutarHerramienta(
        c,
        { tenantId: tenant, tool: 'crm.borrar_todo', args: {}, actorUserId: usuario },
        deps({ habilitadas: ['crm.borrar_todo'] }),
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No existe una herramienta');
  });

  it('los intentos rechazados también quedan en el libro', async () => {
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND action LIKE 'agent.tool.%' AND result = 'denied'`,
      [tenant],
    );
    expect(r.rows[0].n).toBeGreaterThanOrEqual(4);
  });
});
