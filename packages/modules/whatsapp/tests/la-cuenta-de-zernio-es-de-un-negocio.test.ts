import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount, proveedorDe, registerProvider } from '@iaxti/module-channels';
import { darDeAltaCuentaDeZernio } from '../application/zernio-perfil';
import { createZernioProvider } from '../application/zernio';

/**
 * Una cuenta de Zernio queda en UN negocio, y declarando a Zernio (#1321).
 *
 * Dos defectos que esta prueba existe para cazar:
 *
 * 1. La columna `provider` tiene `DEFAULT 'zavu'`, y `createChannelAccount` no
 *    la recibía: una cuenta de Zernio nacía declarando a Zavu, y su envío y la
 *    firma de su webhook iban al proveedor equivocado.
 * 2. La misma cuenta de Zernio dada de alta en dos tenants. El cruce se
 *    intenta a propósito y tiene que fallar en la base, no en un procedimiento.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  if (!proveedorDe({ kind: 'whatsapp', provider: 'zernio' })) registerProvider(createZernioProvider('whatsapp'));
  await admin.query(
    `INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month,
                              retention_months, api_requests_month, modules)
     VALUES ('zernio1321', 5, 1000, 100, 12, 10000, '[]'::jsonb)
     ON CONFLICT (plan) DO UPDATE SET whatsapp_numbers = 5`,
  );
  const crear = async (nombre: string) =>
    (await admin.query("INSERT INTO tenants (name, plan) VALUES ($1, 'zernio1321') RETURNING id", [nombre])).rows[0].id;
  tenantA = await crear('zernio-A-1321');
  tenantB = await crear('zernio-B-1321');
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    for (const tabla of ['whatsapp_numbers', 'channel_senders', 'channel_accounts', 'audit_log', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]).catch(() => undefined);
    }
  }
  await admin.end();
});

const alta = (tenantId: string, zernioAccountId: string, zernioProfileId: string) =>
  withTenant(admin, tenantId, (c) =>
    darDeAltaCuentaDeZernio(c, {
      tenantId,
      nombre: 'WhatsApp',
      zernioAccountId,
      zernioProfileId,
      credentialRef: 'ZERNIO_LLAVE_PRUEBA',
      webhookSecretRef: 'ZERNIO_WEBHOOK_SECRET_PRUEBA',
    }),
  );

describe('el alta de una cuenta de Zernio', () => {
  it('nace declarando a Zernio, con su cuenta y su perfil, y deja rastro en audit', async () => {
    const { account } = await alta(tenantA, 'acc_1321_A', 'prof_1321_A');
    const fila = (
      await admin.query('SELECT provider, state, config FROM channel_accounts WHERE id = $1', [account.id])
    ).rows[0];
    expect(fila.provider).toBe('zernio');
    expect(fila.state).toBe('active');
    expect(fila.config).toMatchObject({
      zernioAccountId: 'acc_1321_A',
      zernioProfileId: 'prof_1321_A',
      senderId: 'zernio:acc_1321_A',
    });
    const audit = await admin.query(
      `SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'channel.zernio.connected' AND resource_id = $2`,
      [tenantA, account.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('el cruce a propósito: la misma cuenta de Zernio en OTRO negocio se rechaza', async () => {
    await expect(alta(tenantB, 'acc_1321_A', 'prof_1321_B')).rejects.toThrow(/otro negocio/);
    const enB = await admin.query(
      `SELECT 1 FROM channel_accounts WHERE tenant_id = $1 AND config->>'zernioAccountId' = 'acc_1321_A'`,
      [tenantB],
    );
    expect(enB.rowCount).toBe(0);
  });

  it('un proveedor que nadie atiende no se guarda en la cuenta', async () => {
    await expect(
      withTenant(admin, tenantA, (c) =>
        createChannelAccount(c, { tenantId: tenantA, kind: 'whatsapp', name: 'x', provider: 'inventado' }),
      ),
    ).rejects.toThrow(/inventado/);
  });
});
