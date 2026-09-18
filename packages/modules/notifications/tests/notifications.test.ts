import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import type { EventEnvelope } from '@iaxti/core';
import {
  NOTIFICATION_TYPES,
  TIPOS_CRITICOS,
  getPreferences,
  listNotifications,
  markRead,
  setPreference,
} from '../application/notifications';
import { EVENTOS, handleNotifiableEvent, notificationConsumers } from '../application/consumers';
import { renderEmail } from '../application/email';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID(); // ADMIN
const supervisora = randomUUID(); // SUPERVISOR
const vendedor = randomUUID(); // USER

function evento(name: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    id: Math.floor(Math.random() * 1e9),
    name,
    tenantId: tenant,
    payload,
    actor: 'system',
    requestId: null as unknown as string,
    version: 1,
    occurredAt: new Date(),
  };
}

async function avisosDe(userId: string) {
  return withTenant(admin, tenant, (c) => listNotifications(c, tenant, userId));
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('notif-test') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, rol] of [
    [duena, 'ADMIN'],
    [supervisora, 'SUPERVISOR'],
    [vendedor, 'USER'],
  ] as const) {
    await admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_id)
       SELECT $1, $2, id FROM roles WHERE tenant_id IS NULL AND name = $3`,
      [tenant, userId, rol],
    );
  }
});

afterAll(async () => {
  await admin.query('DELETE FROM notification_preferences WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM notifications WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('consumidores (#55)', () => {
  it('registra un consumidor por cada evento del catálogo', () => {
    const consumers = notificationConsumers();
    // Contra la lista, no contra un número: el 7 escrito a mano se
    // desactualizaba cada vez que se agregaba un evento, y lo que fallaba
    // era el test, no el código. Lo que importa es que no falte ninguno.
    expect(consumers.map((c) => c.event).sort()).toEqual([...EVENTOS].sort());
    expect(new Set(consumers.map((c) => c.name)).size).toBe(EVENTOS.length);
    expect(consumers.every((c) => c.moduleId === 'notifications')).toBe(true);
  });

  it('sin dueño avisa a supervisión (no al vendedor); la ráfaga se AGRUPA', async () => {
    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(evento('conversation.unattended', { conversationId: 'c1', waitingMinutes: 12 }), c),
    );
    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(evento('conversation.unattended', { conversationId: 'c2', waitingMinutes: 15 }), c),
    );
    const deSupervisora = await avisosDe(supervisora);
    expect(deSupervisora.unread).toBe(1); // ráfaga agrupada, no apilada
    expect(deSupervisora.items[0].groupCount).toBe(2);
    expect(deSupervisora.items[0].title).toContain('sin dueño');
    expect((await avisosDe(duena)).unread).toBe(1);
    expect((await avisosDe(vendedor)).unread).toBe(0);
  });

  it('la mención llega SOLO al mencionado', async () => {
    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(
        evento('note.mentioned', { mentions: [vendedor], excerpt: 'ojo con la factura' }),
        c,
      ),
    );
    const deVendedor = await avisosDe(vendedor);
    expect(deVendedor.unread).toBe(1);
    expect(deVendedor.items[0].body).toContain('factura');
    expect((await avisosDe(supervisora)).items.some((n) => n.type === 'mencion')).toBe(false);
  });

  it('la preferencia apaga la campana… salvo la crítica para el ADMIN', async () => {
    // La supervisora silencia lo de calidad; la dueña (ADMIN) no puede.
    await withTenant(admin, tenant, (c) =>
      setPreference(c, {
        tenantId: tenant, userId: supervisora, type: 'calidad_numero',
        campana: false, correo: false, esAdmin: false,
      }),
    );
    await expect(
      withTenant(admin, tenant, (c) =>
        setPreference(c, {
          tenantId: tenant, userId: duena, type: 'calidad_numero',
          campana: false, correo: false, esAdmin: true,
        }),
      ),
    ).rejects.toThrow(/crítico/);

    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(
        evento('number.quality_changed', { to: 'red', numberId: 'n1' }),
        c,
      ),
    );
    // La dueña recibe SIEMPRE la crítica; el aviso va solo a ADMINs.
    const deDuena = await avisosDe(duena);
    expect(deDuena.items.some((n) => n.type === 'calidad_numero')).toBe(true);
    expect((await avisosDe(supervisora)).items.some((n) => n.type === 'calidad_numero')).toBe(false);
  });

  it('a verde no avisa; la tarea vencida va a su responsable', async () => {
    const antes = (await avisosDe(duena)).items.length;
    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(evento('number.quality_changed', { to: 'green' }), c),
    );
    expect((await avisosDe(duena)).items.length).toBe(antes);

    await withTenant(admin, tenant, (c) =>
      handleNotifiableEvent(
        evento('activity.due', { ownerId: vendedor, title: 'Llamar a doña Carmen', contactId: 'k1' }),
        c,
      ),
    );
    const deVendedor = await avisosDe(vendedor);
    const tarea = deVendedor.items.find((n) => n.type === 'tarea_vencida');
    expect(tarea?.body).toContain('doña Carmen');
    expect(tarea?.link).toBe('/contactos/k1');
  });
});

describe('campana y preferencias (#55)', () => {
  it('markRead deja el contador en cero (por ids o todo)', async () => {
    const antes = await avisosDe(supervisora);
    expect(antes.unread).toBeGreaterThan(0);
    await withTenant(admin, tenant, (c) => markRead(c, { tenantId: tenant, userId: supervisora }));
    expect((await avisosDe(supervisora)).unread).toBe(0);
  });

  it('las preferencias listan todos los tipos, con las críticas bloqueadas para el ADMIN', async () => {
    const deDuena = await withTenant(admin, tenant, (c) => getPreferences(c, tenant, duena, true));
    expect(deDuena.map((p) => p.type).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    // Todas las críticas, no una: el día que se agregó la segunda, un test
    // que miraba solo 'calidad_numero' no habría notado nada.
    for (const tipo of TIPOS_CRITICOS) {
      const critica = deDuena.find((p) => p.type === tipo)!;
      expect(critica, `falta la preferencia de "${tipo}"`).toBeDefined();
      expect(critica.bloqueada).toBe(true);
      expect(critica.campana).toBe(true);
    }

    const deVendedor = await withTenant(admin, tenant, (c) => getPreferences(c, tenant, vendedor, false));
    expect(deVendedor.find((p) => p.type === 'calidad_numero')?.bloqueada).toBe(false);
  });

  it('la plantilla del correo es sobria: titular, párrafo, un enlace', () => {
    const { subject, html } = renderEmail({
      title: 'Conversación nueva sin dueño',
      body: 'Lleva 12 minutos esperando.',
      link: '/bandeja',
      appUrl: 'https://app-staging.iaxti.cl',
    });
    expect(subject).toBe('Conversación nueva sin dueño');
    expect(html).toContain('https://app-staging.iaxti.cl/bandeja');
    expect(html).toContain('Ajustes → Notificaciones');
    expect(html).not.toMatch(/<img|<table/); // sobria de verdad
  });
});
