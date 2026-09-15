import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  EVENTOS_WEBHOOK,
  conectarSender,
  elegirSender,
  llaveSirveParaAmbiente,
  quienSoy,
  urlWebhook,
  type SenderZavu,
} from '../application/conectar';

// Conectar un canal (#42, #56): que sea UN comando el día que llegue la
// credencial, y que lo que no se pueda decidir solo, no se adivine.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

const wsp: SenderZavu = { id: 'snd_wsp', name: '+56 9 1111 1111', channels: ['whatsapp', 'sms'] };
const otro: SenderZavu = { id: 'snd_wsp2', name: 'Sucursal', channels: ['whatsapp'] };
const ig: SenderZavu = { id: 'snd_ig', name: '@tienda', channels: ['instagram'] };

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name, plan) VALUES ('conectar', 'crece') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.query('DELETE FROM whatsapp_numbers WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('la llave tiene que calzar con el ambiente', () => {
  const prueba = { project: { id: 'p1', name: 'VoxTi Labs' }, isTestMode: true };
  const produccion = { project: { id: 'p1', name: 'VoxTi Labs' }, isTestMode: false };

  it('una llave de PRODUCCIÓN no entra a staging', () => {
    // Es la regla que hasta ahora vivía en la cabeza de alguien: en
    // producción se manda desde el número real del negocio, y una prueba
    // mal apuntada le escribe de verdad a clientes de verdad.
    const r = llaveSirveParaAmbiente(produccion, 'staging');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/mensajes reales a clientes reales/);
  });

  it('sin ambiente declarado también se rechaza la de producción', () => {
    expect(llaveSirveParaAmbiente(produccion, undefined).ok).toBe(false);
  });

  it('una llave de PRUEBA no sirve para producción: no saldría nada', () => {
    const r = llaveSirveParaAmbiente(prueba, 'production');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/no saldrían de verdad/);
  });

  it('cada una en su ambiente, pasa', () => {
    expect(llaveSirveParaAmbiente(prueba, 'staging').ok).toBe(true);
    expect(llaveSirveParaAmbiente(prueba, undefined).ok).toBe(true);
    expect(llaveSirveParaAmbiente(produccion, 'production').ok).toBe(true);
  });

  it('decide por lo que responde la API, no por el prefijo del token', async () => {
    // Un token se puede renombrar; `isTestMode` lo dice la API.
    const llamar = vi.fn().mockResolvedValue(produccion);
    const yo = await quienSoy(llamar);
    expect(llamar).toHaveBeenCalledWith('/me');
    expect(yo.isTestMode).toBe(false);
  });
});

describe('elegir el sender', () => {
  it('con uno solo que sirva, lo toma', () => {
    const r = elegirSender([wsp, ig], 'whatsapp');
    expect('sender' in r && r.sender.id).toBe('snd_wsp');
  });

  it('con varios NO adivina: conectar el número equivocado es caro de deshacer', () => {
    const r = elegirSender([wsp, otro, ig], 'whatsapp');
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toMatch(/elige uno con --sender/);
      expect(r.candidatos.map((s) => s.id)).toEqual(['snd_wsp', 'snd_wsp2']);
    }
  });

  it('sin ninguno, dice qué hacer en vez de fallar seco', () => {
    const r = elegirSender([ig], 'whatsapp');
    expect('error' in r && r.error).toMatch(/partner invitation/);
  });

  it('un sender pedido que no tiene el canal se rechaza', () => {
    const r = elegirSender([wsp, ig], 'whatsapp', 'snd_ig');
    expect('error' in r && r.error).toMatch(/no tiene el canal whatsapp/);
  });
});

describe('conectar de punta a punta', () => {
  it('crea la cuenta, apunta el webhook y entrega el secreto UNA vez', async () => {
    const llamar = vi
      .fn()
      .mockResolvedValueOnce({}) // PATCH del sender
      .mockResolvedValueOnce({ secret: 'whsec_secreto' }); // rotación

    const res = await withTenant(admin, tenant, (c) =>
      conectarSender(c, {
        tenantId: tenant,
        nombre: 'WhatsApp Demo',
        sender: wsp,
        baseUrl: 'https://api-staging.iaxti.cl/',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
        llamar,
      }),
    );

    expect(res.number.senderId).toBe('snd_wsp');
    // El webhook apunta a la cuenta recién creada, no a un id inventado.
    expect(res.webhookUrl).toBe(urlWebhook('https://api-staging.iaxti.cl', res.account.id));
    expect(res.webhookSecret).toBe('whsec_secreto');
    expect(res.avisos).toHaveLength(0);

    const [ruta, init] = llamar.mock.calls[0];
    expect(ruta).toBe('/senders/snd_wsp');
    expect(init.method).toBe('PATCH');
    expect(init.body.webhookEvents).toEqual([...EVENTOS_WEBHOOK]);
    expect(init.body.webhookActive).toBe(true);

    // La credencial viaja por REFERENCIA: en la base queda el nombre.
    expect(res.account.credentialRef).toBe('ZAVU_API_KEY');
  });

  it('si el secreto no se puede rotar, lo dice fuerte: sin él nada entra', async () => {
    const llamar = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('HTTP 403'));

    const res = await withTenant(admin, tenant, (c) =>
      conectarSender(c, {
        tenantId: tenant,
        nombre: 'Sucursal',
        sender: otro,
        baseUrl: 'https://api-staging.iaxti.cl',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
        llamar,
      }),
    );
    expect(res.webhookSecret).toBeNull();
    expect(res.avisos.join(' ')).toMatch(/se rechaza por firma inválida/);
  });
});
