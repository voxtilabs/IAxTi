import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent, updateAgent } from '../application/agents';
import { activeAgent, atiendeClientes } from '../application/copilot';

/**
 * El asistente del dueño no atiende clientes.
 *
 * `activeAgent` es "el primero activo" y los ordena por `created_at`. Desde
 * #410 existen asistentes que no le hablan a nadie de afuera, y si el dueño
 * creaba primero el de estadísticas, el copiloto tomaba ESE para responder
 * un WhatsApp: con su instrucción de reportar cifras y sus herramientas de
 * analytics. Los números del negocio, a un cliente.
 *
 * Este test es el orden exacto que lo provocaba.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;

const enTenant = <T,>(fn: (c: PoolClient) => Promise<T>) => withTenant(pool, tenant, fn);

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  const t = await pool.query("INSERT INTO tenants (name) VALUES ('dueno-no-atiende') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool.end();
});

describe('a quién toma el copiloto para contestar', () => {
  it('con el de números creado PRIMERO, sigue tomando el de ventas', async () => {
    const numeros = await enTenant((c) =>
      createAgent(c, { tenantId: tenant, name: 'Números', objetivo: 'estadisticas' }),
    );
    const ventas = await enTenant((c) =>
      createAgent(c, { tenantId: tenant, name: 'Sofía', objetivo: 'vender' }),
    );
    const elegido = await enTenant((c) => activeAgent(c, tenant));
    expect(elegido?.id).toBe(ventas.id);
    expect(elegido?.id).not.toBe(numeros.id);
  });

  it('sin ninguno que atienda, prefiere NO contestar antes que contestar mal', async () => {
    // Es la decisión importante: el copiloto sin agente se salta el job y la
    // conversación queda para una persona. Tomar el del dueño sería peor que
    // no sugerir nada.
    const todos = await enTenant((c) => activeAgent(c, tenant));
    await enTenant((c) => updateAgent(c, { tenantId: tenant, agentId: todos!.id, active: false }));
    expect(await enTenant((c) => activeAgent(c, tenant))).toBeNull();
  });

  it('un asistente sin objetivo atiende, como antes de que el eje existiera', () => {
    // Los que ya estaban creados no tienen objetivo. Si el filtro los
    // excluyera, el copiloto se apagaría solo en cada negocio existente.
    expect(atiendeClientes({ objetivo: null })).toBe(true);
    expect(atiendeClientes({ objetivo: 'vender' })).toBe(true);
    expect(atiendeClientes({ objetivo: 'estadisticas' })).toBe(false);
  });
});
