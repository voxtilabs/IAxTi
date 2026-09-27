import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { EVENTOS_WEBHOOK, conectarSender, type SenderZavu } from '../application/conectar';

/**
 * Dónde queda el número del negocio, y qué eventos le pedimos a Zavu.
 *
 * `conectarSender` guardaba `input.sender.name` en `display_phone`: el nombre
 * verificado del negocio («Ferretería El Sol») en una columna que se llama
 * teléfono y que la interfaz muestra en mono, donde mono significa «este es el
 * dato duro». Dos consecuencias: el dueño no podía ver desde qué número sale su
 * campaña —ese es el único lugar donde el número aparece— y lo que veía en su
 * lugar se leía como si lo fuera.
 *
 * El dato SÍ venía: el emisor de Zavu trae su `phoneNumber` en E.164. Lo
 * ignorábamos y poníamos otro encima, que es peor que no tenerlo.
 *
 * Y de paso: la lista de eventos del `PATCH /senders/{id}` omitía
 * `message.unsupported`, el único evento de categoría Inbound que dejábamos
 * fuera. Lo que no está en esa lista no llega, así que el mensaje no se veía y
 * la ventana de 24 h no se renovaba.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

/** Un emisor como el que responde Zavu: nombre comercial Y teléfono. */
const conNumero: SenderZavu = {
  id: 'snd_numero',
  name: 'Ferretería El Sol',
  phoneNumber: '+56922013949',
  channels: ['whatsapp'],
};

/** Y uno que no trae el teléfono: la columna queda vacía, no inventada. */
const sinNumero: SenderZavu = {
  id: 'snd_sin_numero',
  name: 'Ferretería El Sol',
  channels: ['whatsapp'],
};

function llamarZavu() {
  return vi
    .fn()
    .mockResolvedValueOnce({}) // PATCH del sender
    .mockResolvedValueOnce({ secret: 'whsec_secreto' }); // rotación
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('numero-del-negocio', 'equipo') RETURNING id",
  );
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('en display_phone va el teléfono', () => {
  it('guarda el número del emisor, no su nombre comercial', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      conectarSender(c, {
        tenantId: tenant,
        nombre: 'WhatsApp Ferretería',
        sender: conNumero,
        baseUrl: 'https://api-staging.iaxti.cl',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
        llamar: llamarZavu(),
      }),
    );

    expect(res.number.displayPhone).toBe('+56922013949');
    // Y no el nombre, que es lo que estaba quedando ahí.
    expect(res.number.displayPhone).not.toBe('Ferretería El Sol');

    // En la base también: es lo que la app lee para mostrar el número.
    const fila = await admin.query(
      'SELECT display_phone FROM whatsapp_numbers WHERE tenant_id = $1 AND sender_id = $2',
      [tenant, conNumero.id],
    );
    expect(fila.rows[0].display_phone).toBe('+56922013949');
  });

  it('sin teléfono queda NULL: un nulo se ve, un nombre se cree', async () => {
    const res = await withTenant(admin, tenant, (c) =>
      conectarSender(c, {
        tenantId: tenant,
        nombre: 'WhatsApp Sucursal',
        sender: sinNumero,
        baseUrl: 'https://api-staging.iaxti.cl',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
        llamar: llamarZavu(),
      }),
    );
    expect(res.number.displayPhone).toBeNull();
  });
});

describe('los eventos que se le piden al emisor', () => {
  it('incluye message.unsupported: los tres eventos de entrada', () => {
    // Lo que no está en esta lista no llega, y no enterarse de un mensaje no se
    // descubre leyendo el código: se descubre cuando el cliente reclama.
    for (const evento of ['message.inbound', 'conversation.new', 'message.unsupported']) {
      expect(EVENTOS_WEBHOOK).toContain(evento);
    }
  });

  it('y viaja en el PATCH que se le manda a Zavu al conectar', async () => {
    const llamar = llamarZavu();
    await withTenant(admin, tenant, (c) =>
      conectarSender(c, {
        tenantId: tenant,
        nombre: 'WhatsApp Eventos',
        sender: { ...conNumero, id: 'snd_eventos' },
        baseUrl: 'https://api-staging.iaxti.cl',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
        llamar,
      }),
    );
    const [ruta, init] = llamar.mock.calls[0];
    expect(ruta).toBe('/senders/snd_eventos');
    expect(init.body.webhookEvents).toContain('message.unsupported');
  });
});
