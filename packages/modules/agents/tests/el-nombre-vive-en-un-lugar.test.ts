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
  it('el prompt del dueño nombra a otra: la identidad va primero y declara que manda', async () => {
    // El caso que la reescritura del rename NO cubre: el dueño escribió un
    // nombre distinto en el prompt DESDE el inicio (o el prompt viene
    // versionado de Langfuse, donde no hay nada que reescribir). Acá la
    // única defensa es la identidad antepuesta.
    const conOtroNombre = await withTenant(admin, tenant, (c) =>
      createAgent(c, {
        tenantId: tenant,
        name: 'José',
        fallbackSystemPrompt: 'Eres Sofía, del salón. Hablas breve.',
        actor: 'test',
      }),
    );
    const capturados: Array<{ system?: string }> = [];
    await withTenant(admin, tenant, (c) =>
      runAgentTask(
        c,
        { tenantId: tenant, agent: conOtroNombre, task: 'responder', prompt: 'Di hola.' },
        espia(capturados),
      ),
    );
    const system = capturados[0]?.system ?? '';
    expect(system).toContain('Te llamas José');
    expect(system.indexOf('Te llamas José')).toBeLessThan(system.indexOf('Sofía'));
    expect(system).toContain('manda sobre cualquier otro');
  });

  it('renombrado por update, el nombre viejo ya NI APARECE en el system', async () => {
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
    // El refuerzo determinista: la reescritura del rename sacó a «Sofía» del
    // prompt configurado, así que el modelo no tiene de dónde sacarla.
    expect(system).not.toContain('Sofía');
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

describe('renombrar reescribe el prompt configurado (#1015, el refuerzo determinista)', () => {
  it('el nombre viejo se reescribe como palabra completa, todas sus menciones', async () => {
    const sofia = await withTenant(admin, tenant, (c) =>
      createAgent(c, {
        tenantId: tenant,
        name: 'Carmen',
        fallbackSystemPrompt: 'Eres Carmen, del salón. Carmen saluda con cariño.',
        actor: 'test',
      }),
    );
    const renombrada = await withTenant(admin, tenant, (c) =>
      updateAgent(c, { tenantId: tenant, agentId: sofia.id, name: 'Pilar', actor: 'test' }),
    );
    expect(renombrada.fallbackSystemPrompt).toBe('Eres Pilar, del salón. Pilar saluda con cariño.');
  });

  it('un nombre que es pedazo de otra palabra no se toca', async () => {
    const sol = await withTenant(admin, tenant, (c) =>
      createAgent(c, {
        tenantId: tenant,
        name: 'Sol',
        fallbackSystemPrompt: 'El Solsticio abre a las 10. Atiende Sol.',
        actor: 'test',
      }),
    );
    const mar = await withTenant(admin, tenant, (c) =>
      updateAgent(c, { tenantId: tenant, agentId: sol.id, name: 'Mar', actor: 'test' }),
    );
    // «Solsticio» sobrevive; el «Sol» suelto cambia.
    expect(mar.fallbackSystemPrompt).toBe('El Solsticio abre a las 10. Atiende Mar.');
  });

  it('si el dueño manda prompt nuevo junto al rename, su texto manda tal cual', async () => {
    const ana = await withTenant(admin, tenant, (c) =>
      createAgent(c, {
        tenantId: tenant,
        name: 'Ana',
        fallbackSystemPrompt: 'Eres Ana.',
        actor: 'test',
      }),
    );
    const conPromptNuevo = await withTenant(admin, tenant, (c) =>
      updateAgent(c, {
        tenantId: tenant,
        agentId: ana.id,
        name: 'Eva',
        fallbackSystemPrompt: 'Atiendes la caja. Nada de nombres.',
        actor: 'test',
      }),
    );
    expect(conPromptNuevo.fallbackSystemPrompt).toBe('Atiendes la caja. Nada de nombres.');
  });
});
