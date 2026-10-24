import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { runAgentTask } from '../application/runtime';
import { createAgent, updateAgent } from '../application/agents';
import type { Agent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

/**
 * El nombre del agente vive en UN lugar: `agents.name` (#1015).
 *
 * Vivía en dos: la columna (de donde sale la firma del worker) y el texto
 * del prompt configurado. Al renombrar, nadie corregía el segundo — medido
 * el 25/10 contra gpt-5-mini: el modelo abría «Hola! Soy Sofía» y el worker
 * firmaba «José — asistente virtual», que es peor que cualquiera de los dos
 * solos. Ahora el runtime antepone la identidad desde la columna y declara
 * que manda sobre cualquier nombre que el prompt diga.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let agent: Agent;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name) VALUES ('nombre-en-un-lugar') RETURNING id",
  );
  tenant = t.rows[0].id;
  agent = await withTenant(admin, tenant, (c) =>
    createAgent(c, {
      tenantId: tenant,
      name: 'Sofía',
      fallbackSystemPrompt: 'Eres Sofía, del salón. Hablas breve y cálida.',
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  for (const tabla of ['agent_executions', 'agents', 'usage_meters', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

function espia(capturados: Array<{ system?: string }>): ModelPortFactory {
  return () => ({
    async generate(args) {
      capturados.push(args);
      return { text: 'ok', tokensIn: 10, tokensOut: 5 };
    },
  });
}

describe('la identidad se antepone en runtime (#1015)', () => {
  it('renombrado, el system lleva el nombre NUEVO aunque el prompt diga el viejo', async () => {
    const renombrado = await withTenant(admin, tenant, (c) =>
      updateAgent(c, { tenantId: tenant, agentId: agent.id, name: 'José', actor: 'test' }),
    );
    const capturados: Array<{ system?: string }> = [];
    await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: renombrado, task: 'responder', prompt: 'Di hola.' },
        espia(capturados),
      ),
    );
    const system = capturados[0]?.system ?? '';
    expect(system).toContain('Te llamas José');
    // La identidad declara que manda: el prompt configurado sigue abajo con
    // su «Sofía» adentro — borrárselo sería editar texto del dueño — pero el
    // modelo recibe primero quién es hoy.
    expect(system.indexOf('Te llamas José')).toBeLessThan(system.indexOf('Sofía'));
    expect(system).toContain('manda sobre cualquier otro');
  });

  it('sin prompt configurado, el nombre sale SOLO de la identidad — no dos veces', async () => {
    // Agente aparte: el update parcial usa COALESCE, así que no hay cómo
    // ANULAR el fallback de uno que ya lo tiene — y está bien que así sea.
    const pelado = await withTenant(admin, tenant, (c) =>
      createAgent(c, { tenantId: tenant, name: 'José', actor: 'test' }),
    );
    const capturados: Array<{ system?: string }> = [];
    await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: pelado, task: 'responder', prompt: 'Di hola.' },
        espia(capturados),
      ),
    );
    const system = capturados[0]?.system ?? '';
    expect(system).toContain('Te llamas José');
    expect(system).toContain('el asistente de este negocio');
    // Una sola mención: el default ya no interpola el nombre por su cuenta.
    expect(system.match(/José/g)).toHaveLength(1);
  });
});
