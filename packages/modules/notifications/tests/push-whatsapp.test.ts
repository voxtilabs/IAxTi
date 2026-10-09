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
  archivePushSubscription,
  FALLAS_PARA_AVISAR,
  listPushSubscriptions,
  registerPushSubscription,
  saludDelPush,
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

  it('una suscripción que el servicio declara muerta se ARCHIVA, no se borra', async () => {
    // Antes hacía DELETE, con el argumento de que guardar una muerta es
    // acumular basura. La parte buena del argumento —no seguir intentándolo— se
    // conserva: deja de aparecer en la lista. La mala era borrar el rastro de
    // que ese dispositivo recibía avisos, que es lo que alguien quiere mirar
    // cuando dice «no me llega nada» (#698, SPEC §39).
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, sub('https://push.test/b')));
    const sender = vi.fn().mockResolvedValue({ statusCode: 410 });
    const res = await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: duena, payload: { title: 'hola' }, sender }),
    );
    expect(res.some((r) => r.estado === 'muerta')).toBe(true);
    const quedan = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, duena));
    expect(quedan.map((s) => s.endpoint)).not.toContain('https://push.test/b');

    const fila = await admin.query(
      'SELECT archived_at, archived_reason FROM push_subscriptions WHERE endpoint = $1',
      ['https://push.test/b'],
    );
    expect(fila.rowCount, 'la fila sigue ahí: se archiva, no se borra').toBe(1);
    expect(fila.rows[0].archived_at).toBeTruthy();
    expect(fila.rows[0].archived_reason).toBe('el servicio dijo que ya no existe');
  });

  it('sin llaves VAPID no se finge un envío', async () => {
    expect(vapidFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    const res = await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: duena, payload: { title: 'hola' }, sender: null }),
    );
    expect(res.every((r) => r.estado === 'sin_configurar')).toBe(true);
  });

  it('un error del servicio se anota pero no borra la suscripción', async () => {
    await withTenant(admin, tenant, (c) =>
      archivePushSubscription(c, tenant, 'https://push.test/a', 'el usuario lo quitó'),
    );
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

describe('la salud de los avisos se LEE (#698)', () => {
  /**
   * `last_ok_at` y `failed_at` se escribían en cada envío y ninguna consulta las
   * devolvía: una suscripción muerta hace semanas seguía en la tabla y el
   * producto creía que estaba avisando. El dueño no recibía nada y nadie se
   * enteraba — ni él, ni nosotros.
   */
  const otroUsuario = randomUUID();
  const suyo = (endpoint: string) => ({
    tenantId: tenant, userId: otroUsuario, endpoint, p256dh: 'pk', auth: 'sk',
  });

  it('un error aislado NO se avisa en pantalla', async () => {
    // Tres fallas seguidas y no una: la red de un celular falla sola, y el
    // servicio del navegador tiene malos minutos. Avisar al primer error
    // llenaría la pantalla de avisos falsos, y un aviso falso enseña a ignorar
    // los verdaderos — el mismo problema que esto arregla, por el otro lado.
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, suyo('https://push.test/s1')));
    const sender = vi.fn().mockResolvedValue({ statusCode: 500 });
    await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: otroUsuario, payload: { title: 'x' }, sender }),
    );
    const [d] = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, otroUsuario));
    expect(d.fallasSeguidas).toBe(1);
    expect(d.ultimaFallaEl).toBeInstanceOf(Date);
    expect(d.avisarQueNoLlega, 'una sola falla no es un dispositivo roto').toBe(false);
  });

  it('a las N seguidas sí, y eso es lo que la pantalla dice', async () => {
    const sender = vi.fn().mockResolvedValue({ statusCode: 500 });
    for (let i = 1; i < FALLAS_PARA_AVISAR; i += 1) {
      await withTenant(admin, tenant, (c) =>
        sendPushToUser(c, { tenantId: tenant, userId: otroUsuario, payload: { title: 'x' }, sender }),
      );
    }
    const [d] = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, otroUsuario));
    expect(d.fallasSeguidas).toBe(FALLAS_PARA_AVISAR);
    expect(d.avisarQueNoLlega).toBe(true);
  });

  it('un envío que sí llega vuelve el contador a cero', async () => {
    // Lo que importa es fallar N veces SEGUIDAS. Un contador que solo sube
    // dejaría el aviso puesto para siempre después de un mal día.
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });
    await withTenant(admin, tenant, (c) =>
      sendPushToUser(c, { tenantId: tenant, userId: otroUsuario, payload: { title: 'ok' }, sender }),
    );
    const [d] = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, otroUsuario));
    expect(d.fallasSeguidas).toBe(0);
    expect(d.ultimaFallaEl, 'y la marca de falla se limpia con él').toBeNull();
    expect(d.ultimoOkEl).toBeInstanceOf(Date);
    expect(d.avisarQueNoLlega).toBe(false);
  });

  it('el diagnóstico cuenta las que fallan, y no cuenta las archivadas', async () => {
    // Criterio 4: se puede ver, sin bloquear. Las archivadas ya no se intentan,
    // así que contarlas sería un número que nunca baja.
    const sender = vi.fn().mockResolvedValue({ statusCode: 500 });
    for (let i = 0; i < FALLAS_PARA_AVISAR; i += 1) {
      await withTenant(admin, tenant, (c) =>
        sendPushToUser(c, { tenantId: tenant, userId: otroUsuario, payload: { title: 'x' }, sender }),
      );
    }
    const antes = await withTenant(admin, tenant, (c) => saludDelPush(c, tenant));
    expect(antes.fallando).toBeGreaterThanOrEqual(1);

    await withTenant(admin, tenant, (c) =>
      archivePushSubscription(c, tenant, 'https://push.test/s1', 'el usuario lo quitó'),
    );
    const despues = await withTenant(admin, tenant, (c) => saludDelPush(c, tenant));
    expect(despues.fallando).toBe(antes.fallando - 1);
    expect(despues.archivadas).toBe(antes.archivadas + 1);
    expect(despues.dispositivos).toBe(antes.dispositivos - 1);
  });

  it('una archivada que vuelve a suscribirse arranca sana', async () => {
    // Pasa de verdad: el dispositivo que falló, el usuario apaga y vuelve a
    // activar. Si el contador o el archivado sobrevivieran, el aviso de «no
    // estamos pudiendo avisarte» quedaría puesto sobre un dispositivo sano.
    await withTenant(admin, tenant, (c) => registerPushSubscription(c, suyo('https://push.test/s1')));
    const [d] = await withTenant(admin, tenant, (c) => listPushSubscriptions(c, tenant, otroUsuario));
    expect(d.endpoint).toBe('https://push.test/s1');
    expect(d.fallasSeguidas).toBe(0);
    expect(d.avisarQueNoLlega).toBe(false);
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
