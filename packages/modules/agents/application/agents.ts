import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import { PROVIDERS, type Provider } from '../domain/config';

// Agent (#47): el asistente del tenant, con TODO configurable.

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  personality: string | null;
  language: string;
  provider: Provider;
  model: string;
  promptName: string | null;
  promptVersion: string | null;
  fallbackSystemPrompt: string | null;
  allowedTools: string[];
  defaultMode: 'assist' | 'autonomous' | 'off';
  autonomousHours: Record<string, unknown>;
  limits: Record<string, unknown>;
  active: boolean;
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    personality: (row.personality as string) ?? null,
    language: row.language as string,
    provider: row.provider as Provider,
    model: row.model as string,
    promptName: (row.prompt_name as string) ?? null,
    promptVersion: (row.prompt_version as string) ?? null,
    fallbackSystemPrompt: (row.fallback_system_prompt as string) ?? null,
    allowedTools: (row.allowed_tools as string[]) ?? [],
    defaultMode: row.default_mode as Agent['defaultMode'],
    autonomousHours: (row.autonomous_hours as Record<string, unknown>) ?? {},
    limits: (row.limits as Record<string, unknown>) ?? {},
    active: row.active as boolean,
  };
}

export interface AgentInput {
  name: string;
  personality?: string;
  language?: string;
  provider?: Provider;
  model?: string;
  promptName?: string;
  promptVersion?: string;
  fallbackSystemPrompt?: string;
  allowedTools?: string[];
  defaultMode?: Agent['defaultMode'];
  autonomousHours?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

export async function createAgent(
  client: PoolClient,
  input: AgentInput & { tenantId: string; actor?: string; requestId?: string },
): Promise<Agent> {
  if (!input.name?.trim()) throw new Error('El asistente necesita un nombre visible.');
  if (input.provider && !PROVIDERS.includes(input.provider)) {
    throw new Error(`Proveedor desconocido: ${input.provider}.`);
  }
  const r = await client.query(
    `INSERT INTO agents
       (tenant_id, name, personality, language, provider, model, prompt_name,
        prompt_version, fallback_system_prompt, allowed_tools, default_mode,
        autonomous_hours, limits)
     VALUES ($1,$2,$3,COALESCE($4,'es-CL'),COALESCE($5,'google'),
             COALESCE($6,'gemini-flash-latest'),$7,$8,$9,$10,COALESCE($11,'assist'),$12,$13)
     RETURNING *`,
    [
      input.tenantId,
      input.name.trim(),
      input.personality ?? null,
      input.language ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.promptName ?? null,
      input.promptVersion ?? null,
      input.fallbackSystemPrompt ?? null,
      JSON.stringify(input.allowedTools ?? []),
      input.defaultMode ?? null,
      JSON.stringify(input.autonomousHours ?? {}),
      JSON.stringify(input.limits ?? {}),
    ],
  );
  const agent = rowToAgent(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'agents.create',
    resource: 'agent',
    resourceId: agent.id,
    result: 'ok',
    requestId: input.requestId,
    metadata: { name: agent.name, provider: agent.provider, model: agent.model },
  });
  return agent;
}

export async function updateAgent(
  client: PoolClient,
  input: Partial<AgentInput> & {
    tenantId: string;
    agentId: string;
    active?: boolean;
    actor?: string;
    requestId?: string;
  },
): Promise<Agent> {
  if (input.provider && !PROVIDERS.includes(input.provider)) {
    throw new Error(`Proveedor desconocido: ${input.provider}.`);
  }
  const r = await client.query(
    `UPDATE agents SET
       name = COALESCE($3, name),
       personality = COALESCE($4, personality),
       language = COALESCE($5, language),
       provider = COALESCE($6, provider),
       model = COALESCE($7, model),
       prompt_name = COALESCE($8, prompt_name),
       prompt_version = COALESCE($9, prompt_version),
       fallback_system_prompt = COALESCE($10, fallback_system_prompt),
       allowed_tools = COALESCE($11::jsonb, allowed_tools),
       default_mode = COALESCE($12, default_mode),
       autonomous_hours = COALESCE($13::jsonb, autonomous_hours),
       limits = COALESCE($14::jsonb, limits),
       active = COALESCE($15, active),
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [
      input.tenantId,
      input.agentId,
      input.name ?? null,
      input.personality ?? null,
      input.language ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.promptName ?? null,
      input.promptVersion ?? null,
      input.fallbackSystemPrompt ?? null,
      input.allowedTools ? JSON.stringify(input.allowedTools) : null,
      input.defaultMode ?? null,
      input.autonomousHours ? JSON.stringify(input.autonomousHours) : null,
      input.limits ? JSON.stringify(input.limits) : null,
      input.active ?? null,
    ],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese asistente.');
  const agent = rowToAgent(r.rows[0]);
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'agents.update',
    resource: 'agent',
    resourceId: agent.id,
    result: 'ok',
    requestId: input.requestId,
    metadata: { provider: agent.provider, model: agent.model, mode: agent.defaultMode },
  });
  return agent;
}

export async function listAgents(client: PoolClient, tenantId: string): Promise<Agent[]> {
  const r = await client.query('SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at', [
    tenantId,
  ]);
  return r.rows.map(rowToAgent);
}

export async function getAgent(
  client: PoolClient,
  tenantId: string,
  agentId: string,
): Promise<Agent> {
  const r = await client.query('SELECT * FROM agents WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    agentId,
  ]);
  if (r.rowCount === 0) throw new Error('No encontramos ese asistente.');
  return rowToAgent(r.rows[0]);
}
