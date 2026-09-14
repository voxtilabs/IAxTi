import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  getPreferences,
  setPreference,
  TIPOS_CRITICOS,
} from '../application/notifications';
import {
  deletePushSubscription,
  listPushSubscriptions,
  registerPushSubscription,
  sendPushToUser,
  vapidFromEnv,
} from '../application/push';
import { dispatchTeamWhatsApp, teamWhatsAppTargets } from '../application/equipo-whatsapp';

// Notificaciones v2 (#78): push al navegador y WhatsApp al equipo.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const duena = randomUUID();
const vendedor = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('avisos-v2') RETURNING id");
  tenant = t.rows[0].id;
  await admin.query(
    `INSERT INTO user_profiles (user_id, name, phone) VALUES ($1, 'Dueña', '+56912340001'), ($2, 'Vendedor', NULL)
     ON CONFLICT (user_id) DO NOTHING`,
    [duena, vendedor],
  );
});

afterAll(async () => {
  await admin.query('DELETE FROM push_subscriptions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM notification_preferences WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_profiles WHERE user_id = ANY($1::uuid[])', [[duena, vendedor]]);
  await admin.end();
});

const sub = (endpoint: string) => ({
  tenantId: tenant,
  userId: duena,
  endpoint,
  p256dh: 'llave-publica',
  auth: 'secreto',
});

describe('suscripciones de push (#78)', () => {
  it('el mismo navegador que vuelve a suscribirse no se duplica', async () => {
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, sub('https://push.test/a')));
    await withTenant(admin, tenant, (c) =>
      registerPushSubscription(c, { ...sub('https://push.test/a'), p256dh: 'llave-nueva' }),
    );
    const subs = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, duena));
    expect(subs).toHaveLength(1);
    expect(subs[0].keys.p256dh).toBe('llave-nueva');
  });

  it('una suscripción que el servicio declara muerta se borra sola', async () => {
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, sub('https://push.test/b')));
    const sender = vi.fn().mockResolvedValue({ statusCode: 410 });
    const res = await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: duena, payload: { title: 'hola' }, sender }),
    );
    expect(res.some((r) => r.estado === 'muerta')).toBe(true);
    const quedan = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, duena));
    expect(quedan.map((s) => s.endpoint)).not.toContain('https://push.test/b');
  });

  it('sin llaves VAPID no se finge un envío', async () => {
    expect(vapidFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    const res = await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: duena, payload: { title: 'hola' }, sender: null }),
    );
    expect(res.every((r) => r.estado === 'sin_configurar')).toBe(true);
  });

  it('un error del servicio se anota pero no borra la suscripción', async () => {
    await withTenant(admin, tenant, (c) => deletePushSubscription(c, tenant, 'https://push.test/a'));
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, sub('https://push.test/c')));
    const sender = vi.fn().mockResolvedValue({ statusCode: 500 });
    const res = await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: duena, payload: { title: 'x' }, sender }),
    );
    expect(res[0]).toMatchObject({ estado: 'error' });
    const quedan = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, duena));
    expect(quedan).toHaveLength(1);
  });
});

describe('WhatsApp al equipo (#78)', () => {
  const critico = [...TIPOS_CRITICOS][0]!;

  it('es opt-in y solo para críticos', async () => {
    // Nace apagado: nadie recibe WhatsApp sin pedirlo.
    const antes = await withTenant(admin, tenant, (c) =>
      teamWhatsAppTargets(c, tenant, critico, [duena, vendedor]),
    );
    expect(antes).toHaveLength(0);

    await withTenant(admin, tenant, (c) =>
      setPreference(c, {
        tenantId: tenant,
        userId: duena,
        type: critico,
        campana: true,
        correo: true,
        whatsapp: true,
        esAdmin: false,
      }),
    );
    const despues = await withTenant(admin, tenant, (c) =>
      teamWhatsAppTargets(c, tenant, critico, [duena, vendedor]),
    );
    expect(despues).toHaveLength(1);
    expect(despues[0]).toMatchObject({ userId: duena, phone: '+56912340001' });

    // Pedirlo para un aviso que no es crítico se rechaza con su motivo.
    await expect(
      withTenant(admin, tenant, (c) =>
        setPreference(c, {
          tenantId: tenant,
          userId: duena,
          type: 'mencion',
          campana: true,
          correo: true,
          whatsapp: true,
          esAdmin: false,
        }),
      ),
    ).rejects.toThrow(/solo salen los avisos críticos/);
  });

  it('sin teléfono en el perfil no hay a dónde mandar', async () => {
    await withTenant(admin, tenant, (c) =>
      setPreference(c, {
        tenantId: tenant,
        userId: vendedor,
        type: critico,
        campana: true,
        correo: true,
        whatsapp: true,
        esAdmin: false,
      }),
    );
    const destinos = await withTenant(admin, tenant, (c) =>
      teamWhatsAppTargets(c, tenant, critico, [vendedor]),
    );
    expect(destinos).toHaveLength(0);
  });

  it('con el canal apagado degrada y dice por qué; con canal, manda', async () => {
    const apagado = await withTenant(admin, tenant, (c) =>
      dispatchTeamWhatsApp(c, {
        tenantId: tenant,
        type: critico,
        userIds: [duena],
        title: 'Tu número quedó en rojo',
        enviar: null,
      }),
    );
    expect(apagado[0]).toMatchObject({ enviado: false });
    expect(apagado[0].motivo).toMatch(/apagado/);

    const enviar = vi.fn().mockResolvedValue(undefined);
    const ok = await withTenant(admin, tenant, (c) =>
      dispatchTeamWhatsApp(c, {
        tenantId: tenant,
        type: critico,
        userIds: [duena],
        title: 'Tu número quedó en rojo',
        body: 'Pausamos los envíos del negocio.',
        enviar,
      }),
    );
    expect(ok[0].enviado).toBe(true);
    expect(enviar).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+56912340001', texto: expect.stringContaining('en rojo') }),
    );

    // Fuera de la ventana de 24 h el envío se rechaza: el aviso NO se pierde,
    // queda en la campana, y el motivo viaja para poder explicarlo.
    const falla = vi.fn().mockRejectedValue(new Error('ventana cerrada'));
    const rechazado = await withTenant(admin, tenant, (c) =>
      dispatchTeamWhatsApp(c, {
        tenantId: tenant,
        type: critico,
        userIds: [duena],
        title: 'x',
        enviar: falla,
      }),
    );
    expect(rechazado[0]).toMatchObject({ enviado: false, motivo: 'ventana cerrada' });
  });
});

describe('preferencias con cuatro canales (#78)', () => {
  it('push nace encendido, WhatsApp apagado, y los no críticos no ofrecen WhatsApp', async () => {
    const prefs = await withTenant(admin, tenant, (c) => getPreferences(c, tenant, randomUUID(), false));
    const mencion = prefs.find((p) => p.type === 'mencion')!;
    expect(mencion.push).toBe(true);
    expect(mencion.whatsapp).toBe(false);
    expect(mencion.whatsappNoAplica).toBe(true);

    const calidad = prefs.find((p) => p.type === 'calidad_numero')!;
    expect(calidad.whatsappNoAplica).toBe(false);
    expect(calidad.whatsapp).toBe(false);
  });
});
