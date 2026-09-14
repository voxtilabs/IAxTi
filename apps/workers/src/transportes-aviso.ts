import webpush from 'web-push';
import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { getProvider, listChannelAccounts } from '@iaxti/module-channels';
import {
  vapidFromEnv,
  type EnvioEquipo,
  type PushSender,
  type Transportes,
} from '@iaxti/module-notifications';

// Los transportes de los avisos (#78). Viven en el worker porque es quien
// tiene las llaves y el canal a mano; el módulo notifications no sabe de
// ninguno de los dos y por eso puede probarse sin red.

function pushSender(): PushSender | null {
  const vapid = vapidFromEnv();
  if (!vapid) {
    console.warn('workers: sin llaves VAPID; el push web queda apagado.');
    return null;
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return async (sub, payload) => {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      { TTL: 3600 },
    );
    return { statusCode: res.statusCode };
  };
}

/**
 * Aviso al equipo por el número del negocio. Degrada por capabilities: si el
 * tenant no tiene canal de WhatsApp activo, no hay a quién pedirle el envío
 * y el aviso se queda en la campana y el correo.
 */
function whatsappEquipo(pool: Pool): EnvioEquipo {
  return async ({ tenantId, phone, texto }) => {
    const cuentas = await withTenant(pool, tenantId, (c) => listChannelAccounts(c, tenantId));
    const cuenta = cuentas.find((a) => a.kind === 'whatsapp' && a.state === 'active');
    if (!cuenta) throw new Error('El negocio no tiene WhatsApp conectado.');
    const provider = getProvider('whatsapp');
    if (!provider) throw new Error('El canal de WhatsApp está apagado en este despliegue.');
    await provider.send(cuenta, { to: phone, type: 'texto', body: texto });
  };
}

export function transportesDeAviso(pool: Pool | null): Transportes {
  return {
    push: pushSender(),
    whatsappEquipo: pool ? whatsappEquipo(pool) : null,
  };
}
