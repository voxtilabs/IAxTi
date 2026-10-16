import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { incrementUsage, getUsage } from '@iaxti/module-organizations';
import { transcribeInboundAudio } from '../application/copilot';
import { olvidarLaSemilla } from '../application/defecto-de-la-plataforma';
import { olvidarLosCastigos } from '../application/castigados';
import { runAgentTask } from '../application/runtime';
import { createAgent } from '../application/agents';
import { audioSintetico } from './audio-fixture';

let pool: Pool;
let tenant: string;
let message: string;
const requestId = 'transcripcion-sintetica-864';
const respuesta = () => Response.json({ text: 'Texto sintético, persona@example.test', usage: { type: 'tokens', input_tokens: 100, output_tokens: 20 } });
const input = () => ({ tenantId: tenant, messageId: message, bytes: audioSintetico(), contentType: 'audio/wav', requestId });
const ejecutar = () => withTenant(pool, tenant, c => transcribeInboundAudio(c, input()));
beforeAll(async () => { pool = createPool(); await runMigrations(pool); });
beforeEach(async () => {
  olvidarLaSemilla(); olvidarLosCastigos();
  for (const variable of ['OPENAI_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','GLM_API_KEY','ANTHROPIC_API_KEY']) vi.stubEnv(variable, '');
  vi.stubEnv('OPENAI_API_KEY', 'ficticia-864'); vi.stubEnv('OPENAI_API_BASE', 'https://proveedor.invalid/v1');
  vi.stubGlobal('fetch', vi.fn(async () => respuesta()));
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('audio-sintetico-864') RETURNING id")).rows[0].id;
  message = (await withTenant(pool, tenant, c => receiveInbound(c, { tenantId: tenant, channel: 'simulador', phone: '+56970000864', type: 'audio' }))).message.id;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); olvidarLaSemilla(); olvidarLosCastigos(); });
afterAll(async () => { await pool.end(); });

describe('nota de voz → puerto → mensaje/Execution/cuota/rastro, Postgres real', () => {
  it('sin Google, llama OpenAI y registra uso/costo/rastro sin texto ni audio en Execution/audit/eventos', async () => {
    expect(await ejecutar()).toBe('Texto sintético, persona@example.test');
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/audio/transcriptions');
    const ejec = (await pool.query('SELECT * FROM agent_executions WHERE tenant_id=$1', [tenant])).rows;
    expect(ejec).toHaveLength(1);
    expect(ejec[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini-transcribe', tokens_in: 100, tokens_out: 20, cost_usd: '0.000225', trace_id: requestId, status: 'ok' });
    const audit = (await pool.query("SELECT * FROM audit_log WHERE tenant_id=$1 AND action='agents.transcribed'", [tenant])).rows;
    expect(audit).toHaveLength(1); expect(audit[0].metadata.executionId).toBe(ejec[0].id);
    expect(audit[0].actor_kind).toBe('system');
    const eventos = (await pool.query("SELECT * FROM outbox WHERE tenant_id=$1 AND name='agent.executed'", [tenant])).rows;
    expect(eventos).toHaveLength(1);
    expect(JSON.stringify([ejec, audit, eventos])).not.toContain('persona@example.test');
    expect(JSON.stringify([ejec, audit, eventos])).not.toContain(Buffer.from(audioSintetico()).toString('base64'));
    expect(await withTenant(pool, tenant, c => getUsage(c, tenant, 'ia_executions'))).toBe(1);
    expect((await pool.query('SELECT transcription FROM messages WHERE id=$1', [message])).rows[0].transcription).toContain('persona@example.test');
    // Reentrega: el bloqueo del mensaje y transcripción persistida evitan otra factura.
    await ejecutar(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('no inventa consumo cero si el proveedor omite usage', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ text: 'sin uso' }));
    await ejecutar();
    expect((await pool.query('SELECT tokens_in,tokens_out,cost_usd FROM agent_executions WHERE tenant_id=$1', [tenant])).rows[0]).toEqual({ tokens_in: null, tokens_out: null, cost_usd: null });
  });
  it('no llama ni escribe por un messageId de otro negocio, incluso conectado como owner', async () => {
    const otro = (await pool.query("INSERT INTO tenants(name) VALUES ('otro-audio-864') RETURNING id")).rows[0].id;
    expect(await withTenant(pool, otro, c => transcribeInboundAudio(c, { ...input(), tenantId: otro }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT transcription FROM messages WHERE id=$1', [message])).rows[0].transcription).toBeNull();
  });
  it('la cuota agotada se comprueba antes de la llamada y no usa un económico de chat para audio', async () => {
    await pool.query("UPDATE tenants SET settings=$2 WHERE id=$1", [tenant, { ia: { economico: { provider: 'openai', model: 'gpt-5-mini' } } }]);
    await withTenant(pool, tenant, c => incrementUsage(c, tenant, 'ia_executions', 1000000));
    expect(await ejecutar()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    const ej = (await pool.query('SELECT error,status,error_del_proveedor FROM agent_executions WHERE tenant_id=$1', [tenant])).rows[0];
    expect(ej.status).toBe('failed'); expect(ej.error_del_proveedor).toBe(false); expect(ej.error).toContain('cuota');
  });
  it('fallo del proveedor no fuga su cuerpo con PII/secretos ni borra el audio', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ error: { message: 'persona@example.test Bearer ejemplo-secreto audio-texto', type: 'insufficient_quota' } }, { status: 402 }));
    expect(await ejecutar()).toBeNull();
    const filas = (await pool.query('SELECT * FROM agent_executions WHERE tenant_id=$1', [tenant])).rows;
    expect(filas[0]).toMatchObject({ status: 'failed', error_del_proveedor: true });
    expect(JSON.stringify(filas)).not.toMatch(/persona@example|ejemplo-secreto|audio-texto/);
    expect((await pool.query('SELECT type,transcription FROM messages WHERE id=$1', [message])).rows[0]).toEqual({ type: 'audio', transcription: null });
  });
  it('soloProveedor Google sin credencial no envía a OpenAI', async () => {
    await pool.query('UPDATE tenants SET settings=$2 WHERE id=$1', [tenant, { ia: { soloProveedor: 'google' } }]);
    expect(await ejecutar()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
    expect((await pool.query('SELECT provider FROM agent_executions WHERE tenant_id=$1', [tenant])).rows[0].provider).toBe('google');
  });
  it('sin texto se registra intento consumido pero fallo, sin afirmar transcripción exitosa', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ text: '', usage: { type: 'tokens', input_tokens: 100, output_tokens: 0 } }));
    expect(await ejecutar()).toBeNull();
    expect((await pool.query('SELECT status,error,cost_usd FROM agent_executions WHERE tenant_id=$1', [tenant])).rows[0]).toMatchObject({ status: 'failed', cost_usd: '0.000125' });
    expect((await pool.query("SELECT result FROM audit_log WHERE tenant_id=$1 AND action='agents.transcribed'", [tenant])).rows[0].result).toBe('failed');
    expect((await pool.query("SELECT name FROM outbox WHERE tenant_id=$1 AND name LIKE 'agent.%'", [tenant])).rows.map(r => r.name)).toEqual(['agent.failed']);
    expect(await withTenant(pool, tenant, c => getUsage(c, tenant, 'ia_executions'))).toBe(1);
  });
  it('dos reentregas concurrentes de una transcripción confirmada hacen una sola llamada', async () => {
    const resultados = await Promise.all([ejecutar(), ejecutar()]);
    expect(resultados).toEqual(['Texto sintético, persona@example.test', 'Texto sintético, persona@example.test']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('la ruta de tareas de texto jamás manda transcribir al modelo de chat', async () => {
    const agente = await withTenant(pool, tenant, c => createAgent(c, { tenantId: tenant, name: 'Sintético', actor: 'test' }));
    const factory = vi.fn(() => { throw new Error('no debe elegir chat'); });
    const r = await withTenant(pool, tenant, c => runAgentTask(c, { tenantId: tenant, agent: agente, task: 'transcribir', prompt: 'texto no es audio' }, factory));
    expect(r.status).toBe('failed'); expect(r.error).toContain('puerto de audio'); expect(factory).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('RLS no deja ver la Execution y su rastro desde otro tenant', async () => {
    await ejecutar();
    const otro = (await pool.query("INSERT INTO tenants(name) VALUES ('rls-audio-864') RETURNING id")).rows[0].id;
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='iaxti_audio_864') THEN CREATE ROLE iaxti_audio_864 NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$");
    await pool.query('GRANT USAGE ON SCHEMA public TO iaxti_audio_864');
    await pool.query('GRANT SELECT ON agent_executions,audit_log TO iaxti_audio_864');
    await withTenant(pool, otro, async c => {
      await c.query('SET LOCAL ROLE iaxti_audio_864');
      expect((await c.query('SELECT id FROM agent_executions WHERE tenant_id=$1', [tenant])).rowCount).toBe(0);
      expect((await c.query('SELECT id FROM audit_log WHERE tenant_id=$1', [tenant])).rowCount).toBe(0);
    });
  });
  it('si el audit falla revierte transcripción, Execution y consumo en la misma transacción', async () => {
    await expect(withTenant(pool, tenant, async c => {
      const client = { query: (sql: string, args?: unknown[]) => {
        if (/INSERT INTO audit_log/.test(sql)) throw new Error('audit falla sintética');
        return c.query(sql, args);
      } } as unknown as PoolClient;
      return transcribeInboundAudio(client, input());
    })).rejects.toThrow('audit falla sintética');
    expect((await pool.query('SELECT transcription FROM messages WHERE id=$1', [message])).rows[0].transcription).toBeNull();
    expect((await pool.query('SELECT id FROM agent_executions WHERE tenant_id=$1', [tenant])).rowCount).toBe(0);
    expect(await withTenant(pool, tenant, c => getUsage(c, tenant, 'ia_executions'))).toBe(0);
  });
});
