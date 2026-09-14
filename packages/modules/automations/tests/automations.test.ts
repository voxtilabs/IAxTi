import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { createPipeline, createDeal, optOut } from '@iaxti/module-crm';
import {
  RULE_TEMPLATES,
  evaluateConditions,
  ruleModuleGaps,
  validateRule,
} from '../domain/rules';
import {
  createRule,
  getRule,
  listRules,
  previewRule,
  seedTemplates,
  setRuleActive,
} from '../application/rules';
import { handleAutomationEvent, runRule, sweepTimeRules } from '../application/engine';
import type { Rule } from '../application/rules';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

const TODOS = ['conversations', 'crm'];

let admin: Pool;
let tenant: string;
let conversacion: string;
let contacto: string;
let deal: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('automations-test') RETURNING id");
  tenant = t.rows[0].id;
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56955550001',
      channel: 'simulador',
      body: 'Hola, ¿me cotizan?',
    }),
  );
  conversacion = res.conversation.id;
  contacto = res.contact.id;
  const pipe = await withTenant(admin, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Cotizado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  const d = await withTenant(admin, tenant, (c) =>
    createDeal(c, {
      tenantId: tenant,
      contactId: contacto,
      pipelineId: pipe.pipeline.id,
      title: 'Cotización manicure',
      actor: 'test',
    }),
  );
  deal = d.id;
});

afterAll(async () => {
  for (const tabla of ['rule_runs', 'rules', 'activities', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'internal_notes', 'assignments', 'messages', 'conversations', 'contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

function reglaDe(shape: Partial<Rule> & { actions: Rule['actions'] }): Promise<Rule> {
  return withTenant(admin, tenant, (c) =>
    createRule(c, {
      tenantId: tenant,
      name: shape.name ?? `regla-${Math.random().toString(36).slice(2, 8)}`,
      trigger: shape.trigger ?? { kind: 'event', event: 'conversation.created' },
      conditions: shape.conditions ?? [],
      actions: shape.actions,
      actor: 'test',
    }),
  );
}

describe('dominio (#62)', () => {
  it('condiciones: eq/gt/in/empty sobre el objeto plano', () => {
    const obj = { channel: 'whatsapp', valueClp: 50000, ownerId: null, state: 'open' };
    expect(evaluateConditions(obj, [{ field: 'channel', op: 'eq', value: 'whatsapp' }])).toBe(true);
    expect(evaluateConditions(obj, [{ field: 'valueClp', op: 'gt', value: 100000 }])).toBe(false);
    expect(evaluateConditions(obj, [{ field: 'state', op: 'in', value: ['new', 'open'] }])).toBe(true);
    expect(evaluateConditions(obj, [{ field: 'ownerId', op: 'empty' }])).toBe(true);
    expect(evaluateConditions({}, [{ field: 'nada', op: 'eq', value: 'x' }])).toBe(false);
  });

  it('validación: catálogo de eventos, horas > 0, acciones conocidas', () => {
    expect(() =>
      validateRule({ trigger: { kind: 'event', event: 'meteorito.cayo' as never }, conditions: [], actions: [{ kind: 'add_note', params: {} }] }),
    ).toThrow(/catálogo/);
    expect(() =>
      validateRule({ trigger: { kind: 'time', time: { base: 'no_reply', hours: 0 } }, conditions: [], actions: [{ kind: 'add_note', params: {} }] }),
    ).toThrow(/horas/);
    expect(() =>
      validateRule({ trigger: { kind: 'event', event: 'deal.created' }, conditions: [], actions: [{ kind: 'send_message', params: { body: ' ' } }] }),
    ).toThrow(/vacío/);
    expect(ruleModuleGaps([{ kind: 'create_activity', params: {} }], ['conversations'])).toEqual(['crm']);
  });

  it('cada vertical trae sus 3 reglas iniciales', () => {
    for (const plantillas of Object.values(RULE_TEMPLATES)) {
      expect(plantillas).toHaveLength(3);
    }
  });
});

describe('el motor (#62)', () => {
  it('seed crea las 3 del rubro APAGADAS y no duplica', async () => {
    const creadas = await withTenant(admin, tenant, (c) =>
      seedTemplates(c, { tenantId: tenant, vertical: 'belleza', actor: 'test' }),
    );
    expect(creadas).toHaveLength(3);
    expect(creadas.every((r) => !r.active)).toBe(true); // preview primero
    const denuevo = await withTenant(admin, tenant, (c) =>
      seedTemplates(c, { tenantId: tenant, vertical: 'belleza', actor: 'test' }),
    );
    expect(denuevo).toHaveLength(0);
  });

  it('activar exige los módulos de sus acciones; apagar siempre se puede', async () => {
    const reglas = await withTenant(admin, tenant, (c) => listRules(c, tenant));
    const conTarea = reglas.find((r) => r.actions.some((a) => a.kind === 'create_activity'))!;
    await expect(
      withTenant(admin, tenant, (c) =>
        setRuleActive(c, { tenantId: tenant, ruleId: conTarea.id, active: true, activeModules: ['conversations'], actor: 'test' }),
      ),
    ).rejects.toThrow(/crm/);
    const activa = await withTenant(admin, tenant, (c) =>
      setRuleActive(c, { tenantId: tenant, ruleId: conTarea.id, active: true, activeModules: TODOS, actor: 'test' }),
    );
    expect(activa.active).toBe(true);
  });

  it('corre por evento: nota + evento automation.ran, y el dedupe no repite', async () => {
    const regla = await reglaDe({
      trigger: { kind: 'event', event: 'agent.escalated' },
      actions: [{ kind: 'add_note', params: { body: 'La IA escaló: revisar.' } }],
    });
    const res = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:${conversacion}:ev1` }, { activeModules: TODOS }),
    );
    expect(res?.status).toBe('ok');
    const nota = await admin.query(
      `SELECT body FROM internal_notes WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenant, conversacion],
    );
    expect(nota.rows[0].body).toContain('escaló');
    const evento = await admin.query(
      `SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND name = 'automation.ran'`,
      [tenant],
    );
    expect(evento.rows[0].n).toBe(1);

    // El MISMO dedupe no vuelve a correr.
    const repetido = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:${conversacion}:ev1` }, { activeModules: TODOS }),
    );
    expect(repetido).toBeNull();
  });

  it('condición que no cumple = ni run ni ruido', async () => {
    const regla = await reglaDe({
      conditions: [{ field: 'channel', op: 'eq', value: 'whatsapp' }], // es simulador
      actions: [{ kind: 'add_note', params: { body: 'no debería existir' } }],
    });
    const res = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:x` }, { activeModules: TODOS }),
    );
    expect(res).toBeNull();
  });

  it('módulo apagado: la regla SE PAUSA con aviso, no falla en silencio', async () => {
    const regla = await reglaDe({
      actions: [{ kind: 'create_activity', params: { title: 'Seguimiento' } }],
    });
    const res = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:pausa` }, { activeModules: ['conversations'] }),
    );
    expect(res?.status).toBe('skipped');
    const pausada = await withTenant(admin, tenant, (c) => getRule(c, tenant, regla.id));
    expect(pausada.active).toBe(false);
    expect(pausada.pauseReason).toContain('crm');
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'automation.paused'`,
      [tenant],
    );
    expect(evento.rows[0].payload.ruleId).toBe(regla.id);
  });

  it('send_message: con consentimiento sale; con opt-out se salta SIN fallar', async () => {
    const regla = await reglaDe({
      actions: [{ kind: 'send_message', params: { body: '¿Seguimos con tu cotización?' } }],
    });
    const ok = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:msg1` }, { activeModules: TODOS }),
    );
    expect(ok?.status).toBe('ok');
    const msg = await admin.query(
      `SELECT body, author_kind, delivery_status FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY seq DESC LIMIT 1`,
      [tenant, conversacion],
    );
    expect(msg.rows[0]).toMatchObject({ author_kind: 'system', delivery_status: 'sent' });

    await withTenant(admin, tenant, (c) => optOut(c, { tenantId: tenant, contactId: contacto, reason: 'prueba' }));
    const sinPermiso = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'conversation', objectId: conversacion, dedupeKey: `${regla.id}:msg2` }, { activeModules: TODOS }),
    );
    expect(sinPermiso?.status).toBe('skipped');
    expect(sinPermiso?.detail).toContain('consentimiento');
    await admin.query('UPDATE contacts SET opted_out_at = NULL WHERE id = $1', [contacto]);
  });

  it('tres fallos sobre el mismo objeto: se detiene para él y avisa', async () => {
    const regla = await reglaDe({
      trigger: { kind: 'event', event: 'deal.created' },
      actions: [{ kind: 'move_stage', params: { stageName: 'EtapaInexistente' } }],
    });
    for (let i = 0; i < 3; i++) {
      const res = await withTenant(admin, tenant, (c) =>
        runRule(c, { tenantId: tenant, rule: regla, objectKind: 'deal', objectId: deal, dedupeKey: `${regla.id}:${deal}:f${i}` }, { activeModules: TODOS }),
      );
      expect(res?.status).toBe('failed');
    }
    const cuarto = await withTenant(admin, tenant, (c) =>
      runRule(c, { tenantId: tenant, rule: regla, objectKind: 'deal', objectId: deal, dedupeKey: `${regla.id}:${deal}:f3` }, { activeModules: TODOS }),
    );
    expect(cuarto?.status).toBe('skipped');
    expect(cuarto?.detail).toContain('detenida');
    const aviso = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'automation.failed'
        ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(aviso.rows[0].payload.stoppedForObject).toBe(true);
  });

  it('handleAutomationEvent corre las reglas activas de ese evento', async () => {
    const regla = await reglaDe({
      trigger: { kind: 'event', event: 'conversation.assigned' },
      actions: [{ kind: 'add_note', params: { body: 'Asignada por el motor.' } }],
    });
    await withTenant(admin, tenant, (c) =>
      setRuleActive(c, { tenantId: tenant, ruleId: regla.id, active: true, activeModules: TODOS, actor: 'test' }),
    );
    const client = await admin.connect();
    try {
      await handleAutomationEvent(
        {
          id: 999001,
          name: 'conversation.assigned',
          tenantId: tenant,
          payload: { conversationId: conversacion },
          actor: 'test',
          requestId: null,
          version: 1,
          occurredAt: new Date(),
        } as never,
        client,
        { activeModules: TODOS },
      );
    } finally {
      client.release();
    }
    const nota = await admin.query(
      `SELECT count(*)::int AS n FROM internal_notes WHERE tenant_id = $1 AND body = 'Asignada por el motor.'`,
      [tenant],
    );
    expect(nota.rows[0].n).toBe(1);
  });

  it('el barrido de tiempo: "sin respuesta 24 h" corre UNA vez por día', async () => {
    // Otra conversación, con el último entrante hace 2 días y sin respuesta.
    const res = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56955550002', channel: 'simulador', body: '¿precios?' }),
    );
    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() - interval '2 days' WHERE id = $1`,
      [res.conversation.id],
    );
    const regla = await reglaDe({
      trigger: { kind: 'time', time: { base: 'no_reply', hours: 24 } },
      actions: [{ kind: 'add_note', params: { body: 'Lleva más de un día esperando.' } }],
    });
    await withTenant(admin, tenant, (c) =>
      setRuleActive(c, { tenantId: tenant, ruleId: regla.id, active: true, activeModules: TODOS, actor: 'test' }),
    );
    const primera = await sweepTimeRules(admin, { activeModules: TODOS });
    expect(primera).toBeGreaterThanOrEqual(1);
    const segunda = await sweepTimeRules(admin, { activeModules: TODOS });
    expect(segunda).toBe(0); // dedupe por día
    await withTenant(admin, tenant, (c) =>
      setRuleActive(c, { tenantId: tenant, ruleId: regla.id, active: false, activeModules: TODOS, actor: 'test' }),
    );
  });

  it('la vista previa dice a quién le aplicaría HOY sin ejecutar nada', async () => {
    const preview = await withTenant(admin, tenant, (c) =>
      previewRule(c, tenant, {
        trigger: { kind: 'time', time: { base: 'no_reply', hours: 24 } },
        conditions: [],
      }),
    );
    expect(preview.length).toBeGreaterThanOrEqual(1);
    expect(preview[0].objectKind).toBe('conversation');

    const conCondicion = await withTenant(admin, tenant, (c) =>
      previewRule(c, tenant, {
        trigger: { kind: 'time', time: { base: 'no_reply', hours: 24 } },
        conditions: [{ field: 'channel', op: 'eq', value: 'whatsapp' }],
      }),
    );
    expect(conCondicion).toHaveLength(0); // todas son simulador
  });
});
