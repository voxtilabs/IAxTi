import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { cierreSettings } from '../domain/cierre';
import { archiveTenant, autoResolveTenant } from '../application/cierre';
import { receiveInbound } from '../application/conversations';
import { listInbox } from '../application/inbox';
import { searchConversations } from '../application/equipo';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;
let vieja: string; // open, sin actividad hace 8 días
let fresca: string; // open, con entrante de hoy

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
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, conversations, messages, assignments, internal_notes, quick_replies TO iaxti_app',
  );
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_app');
  await admin.query('GRANT SELECT ON tenants, user_roles TO iaxti_app');
  // `usage_meters`: desde #213 cada conversación que recibe algo cuenta como
  // activa del ciclo, y eso lo escribe el MISMO camino de entrada. El rol de
  // la aplicación necesita poder sumarlo o la bandeja deja de recibir.
  await admin.query('GRANT SELECT, INSERT, UPDATE ON usage_meters TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('cierre-test') RETURNING id");
  tenant = t.rows[0].id;

  const a = await withTenant(app, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56960000001', channel: 'simulador', body: 'quedó botada' }),
  );
  vieja = a.conversation.id;
  await admin.query(
    `UPDATE conversations SET state = 'open',
       last_message_at = now() - interval '8 days',
       last_inbound_at = now() - interval '8 days'
     WHERE id = $1`,
    [vieja],
  );
  const b = await withTenant(app, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56960000002', channel: 'simulador', body: 'sigo aquí' }),
  );
  fresca = b.conversation.id;
  await admin.query(`UPDATE conversations SET state = 'open' WHERE id = $1`, [fresca]);
});

afterAll(async () => {
  await app.end();
  // audit_log es append-only (ni el test lo borra) y referencia al tenant:
  // el tenant de prueba queda — en CI la base es efímera.
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('ajustes de cierre (dominio, §39)', () => {
  it('7 días y 3 meses por defecto; null desactiva el archivo; basura cae al defecto', () => {
    expect(cierreSettings({})).toEqual({ autoResolveDays: 7, archiveAfterMonths: 3 });
    expect(cierreSettings({ archive_after_months: null }).archiveAfterMonths).toBeNull();
    expect(cierreSettings({ auto_resolve_days: 0, archive_after_months: -2 }))
      .toEqual({ autoResolveDays: 7, archiveAfterMonths: 3 });
    expect(cierreSettings({ auto_resolve_days: 14 }).autoResolveDays).toBe(14);
  });
});

describe('cierre automático y archivo (rol de aplicación)', () => {
  it('cierra la inactiva, respeta la fresca, publica eventos y audita UNA entrada', async () => {
    const res = await withTenant(app, tenant, (c) => autoResolveTenant(c, tenant));
    expect(res.ids).toEqual([vieja]);

    const estados = await admin.query(
      'SELECT id, state FROM conversations WHERE tenant_id = $1 ORDER BY created_at',
      [tenant],
    );
    expect(estados.rows.find((r) => r.id === vieja)?.state).toBe('resolved');
    expect(estados.rows.find((r) => r.id === fresca)?.state).toBe('open');
    expect(await eventos('conversation.auto_resolved')).toBe(1);

    const audit = await admin.query(
      `SELECT metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'conversations.auto_resolve.run' AND actor_kind = 'system'`,
      [tenant],
    );
    expect(audit.rowCount).toBe(1); // una por corrida, no por conversación
    expect(audit.rows[0].metadata.resolved).toBe(1);

    // Idempotente: la segunda corrida no encuentra nada.
    const otra = await withTenant(app, tenant, (c) => autoResolveTenant(c, tenant));
    expect(otra.count).toBe(0);
  });

  it('archiva la resuelta vieja; sale de la bandeja pero sigue en búsqueda y ficha', async () => {
    await admin.query(
      `UPDATE conversations SET last_message_at = now() - interval '4 months' WHERE id = $1`,
      [vieja],
    );
    const res = await withTenant(app, tenant, (c) => archiveTenant(c, tenant));
    expect(res.ids).toEqual([vieja]);
    expect(await eventos('conversation.archived')).toBe(1);

    // Fuera de bandeja y filtros…
    const bandeja = await withTenant(app, tenant, (c) =>
      listInbox(c, tenant, { state: 'resolved' }),
    );
    expect(bandeja.items.map((i) => i.id)).not.toContain(vieja);
    // …pero la historia sigue: búsqueda y ficha. Nada se borra.
    const hits = await withTenant(app, tenant, (c) =>
      searchConversations(c, { tenantId: tenant, query: 'botada' }),
    );
    expect(hits.some((h) => h.conversationId === vieja)).toBe(true);
    const viva = await admin.query('SELECT archived_at FROM conversations WHERE id = $1', [vieja]);
    expect(viva.rows[0].archived_at).not.toBeNull();

    const segunda = await withTenant(app, tenant, (c) => archiveTenant(c, tenant));
    expect(segunda.count).toBe(0);
  });

  it('archive_after_months null desactiva el archivo', async () => {
    await admin.query(
      `UPDATE tenants SET settings = settings || '{"archive_after_months": null}'::jsonb WHERE id = $1`,
      [tenant],
    );
    await admin.query(
      `UPDATE conversations SET state = 'resolved', last_message_at = now() - interval '1 year' WHERE id = $1`,
      [fresca],
    );
    const res = await withTenant(app, tenant, (c) => archiveTenant(c, tenant));
    expect(res.count).toBe(0);
  });
});
