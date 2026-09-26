import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { VERTICAL_BASES, buildDiff, parseConfiguration } from '../domain/configurator';
import {
  applyProposal,
  dismissProposal,
  pendingProposal,
  proposeConfiguration,
  snapshotConfig,
} from '../application/configurator';
import { DEFAULT_TASK_MODELS } from '../domain/config';
import { createAgent } from '../application/agents';
import type { ModelPortFactory } from '../application/models';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const admina = randomUUID();

const JSON_CONFIG = JSON.stringify({
  pipeline: {
    name: 'Barbería',
    stages: [
      { name: 'Consulta', type: 'open' },
      { name: 'Agendado', type: 'open' },
      { name: 'Ganado', type: 'won' },
      { name: 'Perdido', type: 'lost' },
    ],
  },
  quickReplies: [
    { shortcut: 'horas', body: 'Hola {{nombre}}, ¿para cuándo tu corte?' },
    { shortcut: 'precios', body: 'Corte $12.000, barba $8.000.' },
  ],
  waTemplates: [
    { name: 'recordatorio', body: 'Hola {{1}}, te esperamos mañana a las {{2}}.' },
    { name: 'reactivacion', body: 'Hola {{1}}, ¿agendamos tu corte del mes?' },
    { name: 'gracias', body: 'Gracias por venir, {{1}}. ¡Buena semana!' },
  ],
  nota: 'Adapté la agenda a barbería con reserva y orden de llegada.',
});

const fabrica: ModelPortFactory = () => ({
  async generate() {
    return { text: '```json\n' + JSON_CONFIG + '\n```', tokensIn: 500, tokensOut: 300 };
  },
});

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('config-test') RETURNING id");
  tenant = t.rows[0].id;
  await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
});

afterAll(async () => {
  for (const tabla of ['agent_proposals', 'agent_executions', 'agents', 'usage_meters', 'quick_replies', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('dominio del configurador (#50)', () => {
  it('cada vertical trae base con cierre won/lost y 3 plantillas', () => {
    for (const base of Object.values(VERTICAL_BASES)) {
      expect(base.pipeline.stages.some((s) => s.type === 'won')).toBe(true);
      expect(base.pipeline.stages.some((s) => s.type === 'lost')).toBe(true);
      expect(base.waTemplates).toHaveLength(3);
    }
  });

  it('el parser tolera fences y completa el cierre si el modelo lo olvidó', () => {
    const sinCierre = parseConfiguration(
      '{"pipeline": {"name": "X", "stages": [{"name": "Uno", "type": "open"}]}}',
    );
    expect(sinCierre?.pipeline.stages.map((s) => s.type)).toEqual(['open', 'won', 'lost']);
    expect(parseConfiguration('no soy json')).toBeNull();
  });

  it('el diff marca ya_existe y las plantillas quedan como propuestas', () => {
    const propuesta = parseConfiguration(JSON_CONFIG)!;
    const diff = buildDiff(
      { pipelines: [{ name: 'barbería', stages: ['A'] }], quickReplies: ['horas'], whatsappActivo: false },
      propuesta,
    );
    const por = (n: string) => diff.items.find((i) => i.nombre === n);
    expect(por('Barbería')?.accion).toBe('ya_existe'); // case-insensitive
    expect(por('/horas')?.accion).toBe('ya_existe');
    expect(por('/precios')?.accion).toBe('crear');
    expect(diff.items.filter((i) => i.tipo === 'wa_template').every((i) => i.accion === 'proponer')).toBe(true);
  });
});

describe('proponer → aplicar (#50)', () => {
  it('propone con el snapshot en el contexto y guarda la propuesta pendiente', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      proposeConfiguration(
        c,
        { tenantId: tenant, description: 'Barbería en Ñuñoa, 3 barberos', vertical: 'belleza', actorUserId: admina },
        fabrica,
      ),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.proposal.status).toBe('pending');
    expect(res.proposal.diff.items.some((i) => i.nombre === 'Barbería')).toBe(true);

    // La corrida quedó como execution `configurar` (modelo de gama alta:
    // el de la tarea, nunca el flash del volumen).
    const ej = await admin.query(
      `SELECT provider, model FROM agent_executions WHERE tenant_id = $1 AND task = 'configurar'`,
      [tenant],
    );
    expect(ej.rows[0].model).toBe(DEFAULT_TASK_MODELS.configurar.model);
    expect(ej.rows[0].model).not.toContain('flash');

    const viva = await withTenant(admin, tenant, (c) => pendingProposal(c, tenant));
    expect(viva?.id).toBe(res.proposal.id);
  });

  it('aplicar crea pipeline y atajos, audita user via agent, y NO pisa lo que ya existe', async () => {
    const viva = (await withTenant(admin, tenant, (c) => pendingProposal(c, tenant)))!;
    const res = await withTenant(admin, tenant, (c) =>
      applyProposal(c, { tenantId: tenant, proposalId: viva.id, actorUserId: admina }),
    );
    expect(res.creado).toEqual({ pipeline: true, quickReplies: 2 });
    expect(res.proposal.status).toBe('applied');

    const audit = await admin.query(
      `SELECT actor_kind, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'agents.configurator.apply'`,
      [tenant],
    );
    expect(audit.rows[0].actor_kind).toBe('user'); // el humano aplica
    expect(audit.rows[0].metadata.via).toBe('agent');

    // Dos veces no.
    await expect(
      withTenant(admin, tenant, (c) =>
        applyProposal(c, { tenantId: tenant, proposalId: viva.id, actorUserId: admina }),
      ),
    ).rejects.toThrow(/ya no está vigente/);
  });

  it('re-ejecutable: la segunda pasada ve lo creado y aplicar no duplica nada', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      proposeConfiguration(
        c,
        { tenantId: tenant, description: 'La misma barbería, segunda pasada', vertical: 'belleza', actorUserId: admina },
        fabrica,
      ),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const items = res.proposal.diff.items;
    expect(items.find((i) => i.nombre === 'Barbería')?.accion).toBe('ya_existe');
    expect(items.find((i) => i.nombre === '/horas')?.accion).toBe('ya_existe');

    const aplicado = await withTenant(admin, tenant, (c) =>
      applyProposal(c, { tenantId: tenant, proposalId: res.proposal.id, actorUserId: admina }),
    );
    expect(aplicado.creado).toEqual({ pipeline: false, quickReplies: 0 });
    const pipes = await admin.query('SELECT count(*)::int AS n FROM pipelines WHERE tenant_id = $1', [tenant]);
    expect(pipes.rows[0].n).toBe(1); // sin duplicados
  });

  it('descartar mata la propuesta; sin descripción no gasta', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      proposeConfiguration(
        c,
        { tenantId: tenant, description: 'Otra pasada para descartar', actorUserId: admina },
        fabrica,
      ),
    );
    if (res.status !== 'ok') throw new Error('esperaba ok');
    await withTenant(admin, tenant, (c) =>
      dismissProposal(c, { tenantId: tenant, proposalId: res.proposal.id, actorUserId: admina }),
    );
    expect(await withTenant(admin, tenant, (c) => pendingProposal(c, tenant))).toBeNull();

    const antes = await admin.query('SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1', [tenant]);
    const vacio = await withTenant(admin, tenant, (c) =>
      proposeConfiguration(c, { tenantId: tenant, description: '  ', actorUserId: admina }, fabrica),
    );
    expect(vacio.status).toBe('failed');
    const despues = await admin.query('SELECT count(*)::int AS n FROM agent_executions WHERE tenant_id = $1', [tenant]);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('el snapshot junta pipelines y atajos del tenant', async () => {
    const snap = await withTenant(admin, tenant, (c) => snapshotConfig(c, tenant));
    expect(snap.pipelines.map((p) => p.name)).toEqual(['Barbería']);
    expect(snap.quickReplies).toEqual(expect.arrayContaining(['horas', 'precios']));
  });
});

describe('la propuesta cortada no pide "más detalle" (#310)', () => {
  const cortada: ModelPortFactory = () => ({
    async generate() {
      return {
        text: '{"pipeline": {"name": "Ventas", "stages": [{"name": "Nuevo", "type": "open"}',
        tokensIn: 500,
        tokensOut: 4000,
        truncada: true,
      };
    },
  });

  it('dice que quedó a medias y pide una descripción MÁS CORTA', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      proposeConfiguration(
        c,
        { tenantId: tenant, description: 'Tengo una barbería en Ñuñoa con dos sillas.', actorUserId: 'u-1' },
        cortada,
      ),
    );
    // La unión discriminada no se estrecha con un `expect`, y el mensaje es
    // justo lo que esta prueba vino a comprobar: se estrecha a mano una vez.
    if (res.status !== 'failed') throw new Error(`Esperábamos que fallara y fue ${res.status}.`);
    expect(res.error).toContain('a medias');
    // El consejo viejo —"intenta de nuevo con más detalle"— empeoraba el
    // problema: más detalle alarga el contexto y lo corta antes. Y esto es
    // lo primero que hace alguien que recién llega al producto.
    expect(res.error).not.toContain('más detalle');
    expect(res.error).toMatch(/más corta/);
  });

  it('no guarda una propuesta a medias', async () => {
    const antes = await admin.query('SELECT count(*) FROM agent_proposals WHERE tenant_id = $1', [tenant]);
    await withTenant(admin, tenant, (c) =>
      proposeConfiguration(c, { tenantId: tenant, description: 'Una barbería.', actorUserId: 'u-1' }, cortada),
    );
    const despues = await admin.query('SELECT count(*) FROM agent_proposals WHERE tenant_id = $1', [tenant]);
    expect(despues.rows[0].count).toBe(antes.rows[0].count);
  });
});

