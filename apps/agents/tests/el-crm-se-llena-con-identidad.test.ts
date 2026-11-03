import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry } from '@iaxti/core';
import { assignRole } from '@iaxti/module-authorization';
import { receiveInbound } from '@iaxti/module-conversations';
import { createAgent, updateAgent } from '@iaxti/module-agents';
import { processSuggest } from '../src/copilot';

/**
 * OJO con los nombres: hay DOS mundos. El catálogo HTTP las llama
 * `deals.create` (sale del operationId) y los manifiestos de módulo más
 * `herramientasExpuestas` las llaman `crm.create_deal`. Lo que se le ofrece
 * al modelo vive en el segundo; las acciones proponibles de #1229, en el
 * primero. Escribir el nombre del mundo equivocado no da error: da cero
 * herramientas, que es como se ve un agente que no puede hacer nada.
 *
 * Con qué identidad trabaja el agente, y por qué eso llena el CRM (#1235).
 *
 * El CRM quedaba vacío mientras el bot atendía bien: cinco conversaciones,
 * cinco contactos, cero oportunidades. No era el modelo — en autónomo corría
 * SIN herramientas, porque viajan con la identidad del dueño de la
 * conversación y una conversación autónoma no tiene dueño.
 *
 * Lo que esta prueba mide es las dos mitades de la misma llave:
 *
 *  1. Con una identidad del EQUIPO, al autónomo le llegan herramientas que
 *     escriben — entre ellas crear la oportunidad.
 *  2. Con una identidad que NO es del negocio, NINGUNA. Esa es la única cosa
 *     que podía salir caro acá, y no se asume: se comprueba.
 */
const recibidas: Array<{ name: string }[]> = [];
vi.mock('@iaxti/module-agents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@iaxti/module-agents')>();
  return {
    ...real,
    providerAvailable: () => true,
    autoRespondForInbound: async (_c: unknown, input: { tools?: Array<{ name: string }> }) => {
      recibidas.push(input.tools ?? []);
      return { action: 'assist' };
    },
  };
});

let pool: Pool;
let tenantId: string;
let agentId: string;
const delEquipo = randomUUID();
const ajeno = randomUUID();

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenantId = (await pool.query("INSERT INTO tenants (name) VALUES ('actua-como') RETURNING id")).rows[0].id;
  await withTenant(pool, tenantId, async (c) => {
    await assignRole(c, { tenantId, userId: delEquipo, roleName: 'ADMIN', actor: 'prueba', createIfMissing: true });
    // Con herramientas configuradas, que es el caso real: `allowedToolsFor` es
    // la unión de lo que el dueño eligió y lo que pide el objetivo, así que un
    // agente sin ninguna de las dos no recibe nada y la prueba mediría otra
    // cosa. Eso es un hueco aparte —`allowed_tools` nace vacío y no hay
    // pantalla para llenarlo— y no es lo que esta prueba cuida.
    const a = await createAgent(c, {
      tenantId,
      name: 'IAxTi',
      defaultMode: 'autonomous',
      allowedTools: ['crm.create_deal', 'crm.find_contact'],
      requestId: 'prueba',
    });
    agentId = a.id;
  });
});
afterAll(async () => {
  await pool.query('DELETE FROM outbox WHERE tenant_id=$1', [tenantId]);
  await pool.end();
});

const correr = async (telefono: string) => {
  recibidas.length = 0;
  const conv = await withTenant(pool, tenantId, (c) =>
    receiveInbound(c, { tenantId, channel: 'whatsapp', phone: telefono, body: 'quiero comprar' }),
  );
  await processSuggest(
    pool,
    { tenantId, conversationId: conv.conversation.id, messageId: conv.message.id, requestId: `req-${telefono}` },
    { registry: new ModuleRegistry().load() },
  );
  return recibidas[0] ?? [];
};

describe('el CRM se llena cuando el agente tiene identidad (#1235)', () => {
  it('con una identidad del equipo, al autónomo le llegan herramientas que escriben', async () => {
    await withTenant(pool, tenantId, (c) =>
      updateAgent(c, { tenantId, agentId, limits: { actua_como_user_id: delEquipo }, requestId: 'prueba' }),
    );
    const tools = await correr('+56944440001');
    const nombres = tools.map((t) => t.name);
    expect(nombres.length, 'tiene que recibir herramientas').toBeGreaterThan(0);
    expect(nombres, 'la que llena el CRM').toContain('crm.create_deal');
  });

  /**
   * Y acá está la propiedad que hace que esto no sea un agujero: `permisosDe`
   * resuelve el rol con `roleOf(tenantId, userId)`, que mira `user_roles` de
   * ESE negocio. Una persona que no es del equipo no tiene fila, así que no
   * tiene rol, así que no tiene permisos — y sin permisos no hay ninguna
   * herramienta que escriba.
   */
  it('con una identidad que NO es del negocio, ninguna herramienta que escriba', async () => {
    await withTenant(pool, tenantId, (c) =>
      updateAgent(c, { tenantId, agentId, limits: { actua_como_user_id: ajeno }, requestId: 'prueba' }),
    );
    const tools = await correr('+56944440002');
    const nombres = tools.map((t) => t.name);
    expect(nombres, 'un id ajeno no puede crear nada').not.toContain('crm.create_deal');
  });

  it('sin la llave, el autónomo sigue como antes: sin herramientas que escriban', async () => {
    await withTenant(pool, tenantId, (c) =>
      updateAgent(c, { tenantId, agentId, limits: {}, requestId: 'prueba' }),
    );
    const tools = await correr('+56944440003');
    expect(tools.map((t) => t.name)).not.toContain('crm.create_deal');
  });
});
