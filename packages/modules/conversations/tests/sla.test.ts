import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { DEFAULT_HORARIO, bandejaSettings, minutosHabilesEntre } from '../domain/horario';
import { autoAssignNew } from '../application/assignment';
import { checkConversationAlerts } from '../application/sla';
import { receiveInbound } from '../application/conversations';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
// Ordenados: el round-robin desempata por user_id cuando nadie ha recibido.
const miembros = [randomUUID(), randomUUID()].sort();

async function setModo(modo: string): Promise<void> {
  await admin.query(
    `UPDATE tenants SET settings = settings || jsonb_build_object('bandeja',
       COALESCE(settings->'bandeja', '{}'::jsonb) || jsonb_build_object('assignmentMode', $2::text))
     WHERE id = $1`,
    [tenant, modo],
  );
}

async function eventos(nombre: string): Promise<number> {
  const r = await admin.query(
    'SELECT count(*)::int AS n FROM outbox WHERE name = $1 AND tenant_id = $2',
    [nombre, tenant],
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_app');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, conversations, messages, assignments TO iaxti_app',
  );
  await admin.query('GRANT SELECT ON tenants, user_roles TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('sla-test') RETURNING id");
  tenant = t.rows[0].id;
  for (const userId of miembros) {
    await admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE tenant_id IS NULL AND name = 'USER'`,
      [tenant, userId],
    );
  }
});

afterAll(async () => {
  await app.end();
  await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('horario hábil (dominio, #38)', () => {
  // Junio 2026: Chile en horario de invierno (UTC-4), sin cambios de hora.
  it('cuenta solo minutos hábiles y salta el fin de semana', () => {
    const viernes1850 = new Date('2026-06-05T22:50:00Z'); // vie 18:50 en Chile
    const lunes0920 = new Date('2026-06-08T13:20:00Z'); // lun 09:20
    expect(minutosHabilesEntre(viernes1850, lunes0920, DEFAULT_HORARIO)).toBe(30);

    const sabado = new Date('2026-06-06T15:00:00Z');
    const domingo = new Date('2026-06-07T15:00:00Z');
    expect(minutosHabilesEntre(sabado, domingo, DEFAULT_HORARIO)).toBe(0);

    const mismodia1 = new Date('2026-06-03T14:00:00Z'); // mié 10:00
    const mismodia2 = new Date('2026-06-03T15:30:00Z'); // mié 11:30
    expect(minutosHabilesEntre(mismodia1, mismodia2, DEFAULT_HORARIO)).toBe(90);
  });

  it('los ajustes caen a los por-defecto de la spec ante basura', () => {
    const s = bandejaSettings({ bandeja: { assignmentMode: 'magia', alertaSinDuenoMinutos: -5 } });
    expect(s.assignmentMode).toBe('manual');
    expect(s.alertaSinDuenoMinutos).toBe(10);
    expect(s.slaPrimeraRespuestaMinutos).toBe(30);
    expect(s.horario.zona).toBe('America/Santiago');
  });
});

describe('asignación automática (rol de aplicación)', () => {
  it('en manual no toca nada', async () => {
    const res = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000001', channel: 'simulador', body: 'hola' }),
    );
    const asignado = await withTenant(app, tenant, (c) =>
      autoAssignNew(c, { tenantId: tenant, conversationId: res.conversation.id }),
    );
    expect(asignado).toEqual({ assignedTo: null, via: 'manual' });
  });

  it('round-robin reparte al que lleva más tiempo sin recibir', async () => {
    await setModo('round_robin');
    const c1 = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000002', channel: 'simulador', body: 'uno' }),
    );
    const a1 = await withTenant(app, tenant, (c) =>
      autoAssignNew(c, { tenantId: tenant, conversationId: c1.conversation.id }),
    );
    expect(a1.assignedTo).toBe(miembros[0]);

    const c2 = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000003', channel: 'simulador', body: 'dos' }),
    );
    const a2 = await withTenant(app, tenant, (c) =>
      autoAssignNew(c, { tenantId: tenant, conversationId: c2.conversation.id }),
    );
    expect(a2.assignedTo).toBe(miembros[1]); // el otro: turno rotativo

    const via = await admin.query('SELECT assigned_via FROM conversations WHERE id = $1', [c1.conversation.id]);
    expect(via.rows[0].assigned_via).toBe('round_robin');
    // Ya con dueño: una segunda pasada no reasigna.
    const repite = await withTenant(app, tenant, (c) =>
      autoAssignNew(c, { tenantId: tenant, conversationId: c1.conversation.id }),
    );
    expect(repite.assignedTo).toBeNull();
  });

  it('al último que atendió: el contacto vuelve a su vendedora', async () => {
    await setModo('last_owner');
    // El contacto de "uno" quedó con miembros[0]; lo resolvemos y vuelve a escribir.
    await admin.query(
      `UPDATE conversations SET state = 'resolved' WHERE tenant_id = $1 AND owner_id = $2`,
      [tenant, miembros[0]],
    );
    await admin.query(
      `UPDATE conversations SET archived_at = now() WHERE tenant_id = $1 AND owner_id = $2`,
      [tenant, miembros[0]],
    );
    const denuevo = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000002', channel: 'simulador', body: 'volví' }),
    );
    expect(denuevo.conversationCreated).toBe(true); // la anterior quedó archivada
    const asignado = await withTenant(app, tenant, (c) =>
      autoAssignNew(c, { tenantId: tenant, conversationId: denuevo.conversation.id }),
    );
    expect(asignado.via).toBe('last_owner');
    expect(asignado.assignedTo).toBe(miembros[0]);
  });
});

describe('avisos y SLA (rol de aplicación)', () => {
  it('new sin dueño más de N minutos avisa UNA vez', async () => {
    const res = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000004', channel: 'simulador', body: 'espero' }),
    );
    await admin.query(
      `UPDATE conversations SET created_at = now() - interval '20 minutes' WHERE id = $1`,
      [res.conversation.id],
    );
    const barrido = await withTenant(app, tenant, (c) => checkConversationAlerts(c, tenant));
    expect(barrido.unattended).toContain(res.conversation.id);
    expect(await eventos('conversation.unattended')).toBeGreaterThanOrEqual(1);

    const segunda = await withTenant(app, tenant, (c) => checkConversationAlerts(c, tenant));
    expect(segunda.unattended).toEqual([]);
  });

  it('el SLA corre en minutos hábiles y publica el incumplimiento una vez', async () => {
    const res = await withTenant(app, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone: '+56930000005', channel: 'simulador', body: 'sin respuesta' }),
    );
    // 3 días atrás: sobran minutos hábiles aunque haya fin de semana al medio.
    await admin.query(
      `UPDATE conversations SET created_at = now() - interval '3 days' WHERE id = $1`,
      [res.conversation.id],
    );
    const barrido = await withTenant(app, tenant, (c) => checkConversationAlerts(c, tenant));
    expect(barrido.breached).toContain(res.conversation.id);
    expect(await eventos('sla.first_response_breached')).toBe(1);

    const segunda = await withTenant(app, tenant, (c) => checkConversationAlerts(c, tenant));
    expect(segunda.breached).toEqual([]);
  });
});
