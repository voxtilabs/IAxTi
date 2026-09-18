import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent } from '../application/agents';
import { suggestForInbound } from '../application/copilot';
import { herramientasExpuestas } from '../application/herramientas-expuestas';
import type { DepsHerramientas } from '../application/herramientas';
import type { ModelPortFactory } from '../application/models';

/**
 * Que la sugerencia USE las herramientas (#240).
 *
 * El issue decía que las 16 herramientas estaban declaradas y no las
 * ejecutaba nadie. Después resultó que el ejecutor también estaba escrito y
 * tampoco lo llamaba nadie. Esta prueba es la que falla si vuelve a pasar:
 * el modelo pide una herramienta, la herramienta corre de verdad, y lo que
 * devolvió termina dentro de la sugerencia guardada.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conversacion: string;
const usuario = randomUUID();

const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

/**
 * Un modelo de mentira que se comporta como uno de verdad con herramientas:
 * si le ofrecen `knowledge.get_product`, la pide antes de responder y usa
 * el precio que le devolvió. Si no se la ofrecen, contesta sin precio.
 */
const modeloQuePregunta: ModelPortFactory = () => ({
  async generate(args) {
    if (args.prompt.startsWith('Resume')) {
      return { text: 'El cliente pregunta por el precio del corte.', tokensIn: 10, tokensOut: 5 };
    }
    const producto = args.tools?.find((h) => h.name === 'knowledge.get_product');
    if (!producto) {
      return {
        text: JSON.stringify({
          sugerencia: 'Déjame confirmar el precio y te aviso.',
          confianza: 0.4,
          intencion: 'consulta',
          calificacion: 'tibio',
          crear_oportunidad: false,
        }),
        tokensIn: 100,
        tokensOut: 30,
      };
    }
    const datos = (await producto.ejecutar({ query: 'corte' })) as
      | Array<{ nombre: string; precio: number }>
      | { error: string };
    const precio = Array.isArray(datos) ? datos[0]?.precio : null;
    return {
      text: JSON.stringify({
        sugerencia: precio ? `El corte sale $${precio}.` : 'No pude confirmar el precio.',
        confianza: 0.9,
        intencion: 'consulta',
        calificacion: 'caliente',
        crear_oportunidad: false,
      }),
      tokensIn: 120,
      tokensOut: 40,
      herramientasUsadas: ['knowledge.get_product'],
    };
  },
});

const deps = (over: Partial<DepsHerramientas> = {}): DepsHerramientas => ({
  actorPuede: async () => true,
  habilitadas: ['knowledge.get_product'],
  getContext: async (id) => ({ conversationId: id }),
  buscarConocimiento: async () => ({ hits: [] }),
  buscarProducto: async (q) => [{ nombre: q, precio: 12000 }],
  ...over,
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('tools-sugerencia') RETURNING id");
  tenant = t.rows[0].id;
  await withTenant(admin, tenant, (c) =>
    createAgent(c, {
      tenantId: tenant,
      name: 'Asistente',
      fallbackSystemPrompt: 'Eres el asistente del negocio.',
      actor: 'test',
    }),
  );
  const contacto = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Ana', '+56966660001', 'whatsapp') RETURNING id`,
    [tenant],
  );
  const conv = await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, state, owner_id)
     VALUES ($1, $2, 'whatsapp', 'open', $3) RETURNING id`,
    [tenant, contacto.rows[0].id, usuario],
  );
  conversacion = conv.rows[0].id;
  await admin.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind)
     VALUES ($1, $2, 'in', 'texto', '¿cuánto sale el corte?', 'contact')`,
    [tenant, conversacion],
  );
});

afterAll(async () => {
  await admin.end();
});

describe('la sugerencia con herramientas', () => {
  it('el precio sale de la herramienta, no de la imaginación del modelo', async () => {
    const s = await en(async (c) => {
      const tools = herramientasExpuestas(
        c,
        {
          tenantId: tenant,
          habilitadas: ['knowledge.get_product'],
          actorUserId: usuario,
          conversationId: conversacion,
        },
        deps(),
      );
      return suggestForInbound(
        c,
        { tenantId: tenant, conversationId: conversacion, tools },
        modeloQuePregunta,
      );
    });
    expect(s?.text).toBe('El corte sale $12000.');
  });

  it('sin herramientas, el mismo modelo no se inventa el precio', async () => {
    const s = await en((c) =>
      suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, modeloQuePregunta),
    );
    // La prueba real de que la herramienta hizo algo: quitarla cambia la
    // respuesta. Si diera lo mismo, no estaría conectada.
    expect(s?.text).toBe('Déjame confirmar el precio y te aviso.');
  });

  it('la ejecución guarda qué herramientas consultó', async () => {
    await en(async (c) => {
      const tools = herramientasExpuestas(
        c,
        {
          tenantId: tenant,
          habilitadas: ['knowledge.get_product'],
          actorUserId: usuario,
          conversationId: conversacion,
        },
        deps(),
      );
      return suggestForInbound(
        c,
        { tenantId: tenant, conversationId: conversacion, tools },
        modeloQuePregunta,
      );
    });
    const r = await admin.query(
      `SELECT output, explanation FROM agent_executions
        WHERE tenant_id = $1 AND task = 'sugerir' ORDER BY created_at DESC LIMIT 1`,
      [tenant],
    );
    // Sin esto, una respuesta con precio real y una inventada se ven igual
    // cuando alguien reclama.
    expect(r.rows[0].output.herramientas).toEqual(['knowledge.get_product']);
    expect(r.rows[0].explanation).toMatch(/Consultó: knowledge.get_product/);
  });
});
