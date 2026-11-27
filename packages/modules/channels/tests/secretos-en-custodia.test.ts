import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount } from '../application/accounts';
import {
  fijarSecretosDelCanal,
  idDeSecretoDelCanal,
  idEnLaReferencia,
  referenciaEnCustodia,
} from '../application/secretos-en-custodia';

/**
 * La referencia a un secreto del canal en la custodia (#1393, ADR-0038).
 *
 * Lo que se cuida: que una referencia SOLO se resuelva para la cuenta y el
 * tipo de secreto para los que se escribió. Copiarla a otra fila —de otro
 * negocio, o la del webhook en el lugar de la llave— la deja sin efecto.
 */
const T1 = '11111111-1111-4111-8111-111111111393';
const T2 = '22222222-2222-4222-8222-222222221393';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa1393';
const ref = (id: string) => `cu:custodia-local/secrets/${id}/versions/1`;

describe('la referencia a la custodia', () => {
  it('se resuelve solo para su cuenta y su tipo de secreto', () => {
    const r = ref(idDeSecretoDelCanal(T1, C1, 'llave'));
    expect(referenciaEnCustodia(r, T1, C1, 'llave')).toBe(r.slice(3));
    expect(referenciaEnCustodia(r, T2, C1, 'llave')).toBeNull();
    expect(referenciaEnCustodia(r, T1, '00000000-0000-4000-8000-000000000000', 'llave')).toBeNull();
    expect(referenciaEnCustodia(r, T1, C1, 'webhook')).toBeNull();
  });

  it('acepta también la forma de Secret Manager, con el mismo id', () => {
    const r = `cu:projects/iaxti-prod/secrets/${idDeSecretoDelCanal(T1, C1, 'webhook')}/versions/3`;
    expect(referenciaEnCustodia(r, T1, C1, 'webhook')).toBe(r.slice(3));
  });

  it('un nombre de variable, un valor pegado o un id a mano no son referencias', () => {
    for (const malo of [
      'ZERNIO_API_KEY',
      'zrk_0123456789abcdef',
      ref(`iaxti-canal-${T1.replaceAll('-', '')}-${C1.replaceAll('-', '')}-llave-no-es-hex`),
      ref(idDeSecretoDelCanal(T1, C1, 'llave')).replace('/versions/1', '/versions/0'),
      ref(idDeSecretoDelCanal(T1, C1, 'llave')).replace('cu:', 'sm:'),
      `${ref(idDeSecretoDelCanal(T1, C1, 'llave'))}/../otro`,
      null,
    ]) {
      expect(referenciaEnCustodia(malo, T1, C1, 'llave'), String(malo)).toBeNull();
    }
  });

  it('el id que se destruye es el de la referencia', () => {
    const id = idDeSecretoDelCanal(T1, C1, 'llave');
    expect(idEnLaReferencia(ref(id).slice(3))).toBe(id);
  });
});

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let admin: Pool;
let tenant: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name, plan) VALUES ('custodia-1393', 'basic') RETURNING id")).rows[0].id;
});

afterAll(async () => {
  for (const tabla of ['channel_accounts', 'audit_log', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]).catch(() => undefined);
  }
  await admin.end();
});

describe('apuntar la cuenta a sus secretos', () => {
  it('cambia las referencias, devuelve las anteriores y lo audita', async () => {
    const cuenta = await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, { tenantId: tenant, kind: 'whatsapp', name: 'WA', credentialRef: 'ZERNIO_VIEJA' }),
    );
    const llave = ref(idDeSecretoDelCanal(tenant, cuenta.id, 'llave'));
    const webhook = ref(idDeSecretoDelCanal(tenant, cuenta.id, 'webhook'));
    const { antes } = await withTenant(admin, tenant, (c) =>
      fijarSecretosDelCanal(c, { tenantId: tenant, accountId: cuenta.id, credentialRef: llave, webhookSecretRef: webhook, actor: 'u-1', actorKind: 'user' }),
    );
    expect(antes.credentialRef).toBe('ZERNIO_VIEJA');
    const fila = (await admin.query('SELECT credential_ref, webhook_secret_ref FROM channel_accounts WHERE id = $1', [cuenta.id])).rows[0];
    expect(fila).toEqual({ credential_ref: llave, webhook_secret_ref: webhook });
    const audit = (
      await admin.query(`SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'channel.secrets.stored'`, [tenant])
    ).rows[0];
    // Dónde estaban y dónde quedaron, por tipo; nunca la referencia ni el valor.
    expect(audit.metadata).toEqual({ credencialAntes: 'entorno', secretoAntes: 'ninguna', ahora: 'custodia' });
  });

  it('no deja apuntar una cuenta al secreto de OTRA', async () => {
    const [a, b] = await withTenant(admin, tenant, async (c) => [
      await createChannelAccount(c, { tenantId: tenant, kind: 'whatsapp', name: 'A' }),
      await createChannelAccount(c, { tenantId: tenant, kind: 'whatsapp', name: 'B' }),
    ]);
    const deA = {
      credentialRef: ref(idDeSecretoDelCanal(tenant, a!.id, 'llave')),
      webhookSecretRef: ref(idDeSecretoDelCanal(tenant, a!.id, 'webhook')),
    };
    await expect(
      withTenant(admin, tenant, (c) =>
        fijarSecretosDelCanal(c, { tenantId: tenant, accountId: b!.id, ...deA, actor: 'u-1', actorKind: 'user' }),
      ),
    ).rejects.toThrow(/no son de la custodia de esta cuenta/);
    // Ni con los dos tipos cruzados en la misma cuenta.
    await expect(
      withTenant(admin, tenant, (c) =>
        fijarSecretosDelCanal(c, {
          tenantId: tenant, accountId: a!.id,
          credentialRef: deA.webhookSecretRef, webhookSecretRef: deA.credentialRef,
          actor: 'u-1', actorKind: 'user',
        }),
      ),
    ).rejects.toThrow();
  });
});
