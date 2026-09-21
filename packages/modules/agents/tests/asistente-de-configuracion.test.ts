import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createAgent, updateAgent } from '../application/agents';
import { agenteQueConfigura } from '../application/configurator';
import { DEFINICIONES } from '../domain/objetivo';

/**
 * El asistente de configuración (#415).
 *
 * El configurador existe desde #50 y usaba "el asistente activo", sin
 * decirlo: si el negocio tenía uno de ventas con un modelo barato, la
 * propuesta —la respuesta más larga y más cara del producto, con el modelo
 * que más razona— salía con ese.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let tenant: string;
const enTenant = <T,>(fn: (c: PoolClient) => Promise<T>) => withTenant(pool, tenant, fn);

beforeAll(async () => {
  pool = createPool(URL);
  await runMigrations(pool);
  const t = await pool.query("INSERT INTO tenants (name) VALUES ('asistente-config') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool.end();
});

describe('quién arma la propuesta de configuración', () => {
  it('sin uno dedicado, el que atiende — el configurador no deja de funcionar', async () => {
    const ventas = await enTenant((c) =>
      createAgent(c, { tenantId: tenant, name: 'Sofía', objetivo: 'vender' }),
    );
    expect((await enTenant((c) => agenteQueConfigura(c, tenant)))?.id).toBe(ventas.id);
  });

  it('con uno dedicado, ese — aunque se haya creado después', async () => {
    const config = await enTenant((c) =>
      createAgent(c, { tenantId: tenant, name: 'Armador', objetivo: 'configuracion' }),
    );
    expect((await enTenant((c) => agenteQueConfigura(c, tenant)))?.id).toBe(config.id);
  });

  it('apagado no cuenta: vuelve al que atiende', async () => {
    const todos = await enTenant((c) => agenteQueConfigura(c, tenant));
    await enTenant((c) => updateAgent(c, { tenantId: tenant, agentId: todos!.id, active: false }));
    const ahora = await enTenant((c) => agenteQueConfigura(c, tenant));
    expect(ahora?.name).toBe('Sofía');
  });
});

describe('el objetivo de configuración', () => {
  it('no tiene NINGUNA herramienta, y es a propósito', () => {
    // Propone; no aplica. Cualquier herramienta que tuviera sería una forma
    // de aplicar algo sin que nadie haya dicho que sí (ADR-0017).
    expect(DEFINICIONES.configuracion.tools).toEqual([]);
    expect(DEFINICIONES.configuracion.destinatario).toBe('dueño');
  });

  it('no promete que algo quedó configurado', () => {
    const i = DEFINICIONES.configuracion.instruccion;
    expect(i).toMatch(/propones|propones/i);
    expect(i).toMatch(/una persona decide|tú propones/i);
  });

  it('no necesita módulos: configurar es del núcleo', () => {
    // Si `requiere` pidiera algo, un negocio recién creado —que es
    // justamente el que necesita configurarse— no podría elegirlo.
    expect(DEFINICIONES.configuracion.requiere).toEqual([]);
  });
});
