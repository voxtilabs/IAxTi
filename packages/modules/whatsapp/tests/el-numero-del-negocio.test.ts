import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { proveedorDe, registerProvider } from '@iaxti/module-channels';
import { darDeAltaCuentaDeZernio } from '../application/zernio-perfil';
import { createZernioProvider } from '../application/zernio';

/**
 * Dónde queda el número del negocio.
 *
 * `display_phone` es lo único donde la interfaz muestra desde qué número sale
 * el WhatsApp del negocio — y en mono, que en esta casa significa «este es el
 * dato duro». El defecto que esta prueba cuida es el de siempre: que caiga
 * otra cosa en esa columna, como el nombre comercial del emisor, que se lee
 * como si fuera el número y no lo es. El dato lo trae el alta: el operador
 * conecta con `--numero` y `darDeAltaCuentaDeZernio` lo guarda tal cual.
 *
 * El alta es la de Zernio (#1321): la cuenta nace declarando su proveedor con
 * `zernioAccountId` y `zernioProfileId` — eso lo prueba
 * `la-cuenta-de-zernio-es-de-un-negocio.test.ts`; acá lo que importa es la
 * columna del número.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;

const alta = (senderId: string, displayPhone?: string) =>
  withTenant(admin, tenant, (c) =>
    darDeAltaCuentaDeZernio(c, {
      tenantId: tenant,
      nombre: 'WhatsApp del negocio',
      zernioAccountId: senderId,
      zernioProfileId: 'prof_numero_negocio',
      ...(displayPhone ? { displayPhone } : {}),
      credentialRef: 'ZERNIO_LLAVE_NEGOCIO',
      webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_NEGOCIO',
    }),
  );

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  // `createChannelAccount` comprueba que el proveedor declarado tenga
  // adaptador en ESTE proceso, como lo hace la API al arrancar.
  if (!proveedorDe({ kind: 'whatsapp', provider: 'zernio' })) registerProvider(createZernioProvider('whatsapp'));
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('numero-del-negocio', 'equipo') RETURNING id",
  );
  tenant = t.rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['whatsapp_numbers', 'channel_senders', 'channel_accounts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await sinTriggers(admin, (c) => c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]));
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('en display_phone va el teléfono', () => {
  it('guarda el número que trae el alta, tal cual', async () => {
    const { account } = await alta('acc_con_numero', '+56922013949');

    const fila = await admin.query(
      'SELECT display_phone FROM whatsapp_numbers WHERE tenant_id = $1 AND channel_account_id = $2',
      [tenant, account.id],
    );
    expect(fila.rows[0].display_phone).toBe('+56922013949');
  });

  it('sin teléfono queda NULL: un nulo se ve, un nombre se cree', async () => {
    const { account } = await alta('acc_sin_numero');

    const fila = await admin.query(
      'SELECT display_phone FROM whatsapp_numbers WHERE tenant_id = $1 AND channel_account_id = $2',
      [tenant, account.id],
    );
    expect(fila.rows[0].display_phone).toBeNull();
  });
});
