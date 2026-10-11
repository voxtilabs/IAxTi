import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { assertChannelTransition, getProvider, registerProvider, resetProviders } from '../domain/port';
import { firmarWebhook, simuladorProvider } from '../application/simulador';
import {
  createChannelAccount,
  findAccountById,
  listChannelAccounts,
  setChannelState,
} from '../application/accounts';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenant: string;

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
  await admin.query('GRANT SELECT, INSERT, UPDATE ON channel_accounts TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('channels-test') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await app.end();
  await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('el puerto (dominio, #41)', () => {
  it('la máquina de estados del canal valida transiciones', () => {
    expect(() => assertChannelTransition('connecting', 'active')).not.toThrow();
    expect(() => assertChannelTransition('active', 'degraded')).not.toThrow();
    expect(() => assertChannelTransition('degraded', 'active')).not.toThrow();
    expect(() => assertChannelTransition('disconnected', 'active')).toThrow(/inválida/);
    expect(() => assertChannelTransition('connecting', 'degraded')).toThrow(/inválida/);
  });

  it('el registro de adaptadores rechaza duplicados por kind', () => {
    resetProviders();
    registerProvider(simuladorProvider);
    expect(getProvider('simulador')?.kind).toBe('simulador');
    expect(() => registerProvider(simuladorProvider)).toThrow(/Ya hay un adaptador/);
    expect(getProvider('whatsapp')).toBeNull();
    resetProviders();
  });

  it('el simulador firma HMAC y normaliza saltándose filas sin id o teléfono', () => {
    const cuerpo = JSON.stringify({ messages: [{ id: 'm1', phone: '+56911112222', body: 'hola' }] });
    const firma = firmarWebhook(cuerpo, 'secreto');
    expect(simuladorProvider.verifyWebhook({ 'x-iaxti-signature': firma }, cuerpo, 'secreto')).toBe(true);
    expect(simuladorProvider.verifyWebhook({ 'x-iaxti-signature': firma }, cuerpo, 'otro')).toBe(false);
    expect(simuladorProvider.verifyWebhook({}, cuerpo, 'secreto')).toBe(false);

    const normalizados = simuladorProvider.normalize({
      messages: [
        { id: 'm1', phone: '+56911112222', body: 'hola' },
        { phone: '+56911112222', body: 'sin id' },
        { id: 'm3', body: 'sin teléfono' },
      ],
    });
    expect(normalizados).toHaveLength(1);
    expect(normalizados[0]).toMatchObject({ providerMessageId: 'm1', type: 'texto' });
  });
});

describe('cuentas de canal (rol de aplicación)', () => {
  it('la cuenta nace connecting, con credenciales POR REFERENCIA', async () => {
    const cuenta = await withTenant(app, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'simulador',
        name: 'Canal de prueba',
        webhookSecretRef: 'WEBHOOK_SECRET_TEST',
        config: { descripcion: 'ids públicos, nunca secretos' },
      }),
    );
    expect(cuenta.state).toBe('connecting');
    expect(cuenta.credentialRef).toBeNull();
    // El secreto NO está en la fila: solo el nombre de la referencia.
    const fila = await admin.query('SELECT webhook_secret_ref FROM channel_accounts WHERE id = $1', [cuenta.id]);
    expect(fila.rows[0].webhook_secret_ref).toBe('WEBHOOK_SECRET_TEST');
  });

  it('los cambios de estado publican channel.connected/degraded/disconnected', async () => {
    const [cuenta] = await withTenant(app, tenant, (c) => listChannelAccounts(c, tenant));
    await withTenant(app, tenant, (c) =>
      setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }),
    );
    await withTenant(app, tenant, (c) =>
      setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'degraded', reason: 'calidad baja' }),
    );
    await expect(
      withTenant(app, tenant, (c) =>
        setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'connecting' }),
      ),
    ).rejects.toThrow(/inválida/);

    const eventos = await admin.query(
      `SELECT name FROM outbox WHERE tenant_id = $1 AND name LIKE 'channel.%' ORDER BY id`,
      [tenant],
    );
    expect(eventos.rows.map((r) => r.name)).toEqual(['channel.connected', 'channel.degraded']);

    // El webhook ubica la cuenta sin tenant (llega de afuera).
    const cliente = await admin.connect();
    try {
      const porId = await findAccountById(cliente, cuenta.id);
      expect(porId?.id).toBe(cuenta.id);
      expect(porId?.webhookSecretRef).toBe('WEBHOOK_SECRET_TEST');
    } finally {
      cliente.release();
    }
  });
});

/**
 * El runbook de producción decía que «los canales y los pagos» rechazaban una
 * credencial pegada. Solo lo hacía payments; acá el INSERT guardaba lo que
 * llegara (#801). Quien le creyó al runbook quedó con un secreto vivo en
 * texto plano, en el campo que después cinco mensajes de error interpolan.
 */
describe('la credencial va por referencia y se comprueba (#801)', () => {
  it('una llave pegada se rechaza, y la cuenta no se crea', async () => {
    const antes = await admin.query(
      'SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1',
      [tenant],
    );
    await expect(
      withTenant(admin, tenant, (c) =>
        createChannelAccount(c, {
          tenantId: tenant,
          kind: 'whatsapp',
          name: 'Con la llave pegada',
          credentialRef: 'zv_live_ac73feebf3f29cd43fcd3222624272ecd2a854133b050eea',
        }),
      ),
    ).rejects.toThrow(/NOMBRE de la variable/);
    const despues = await admin.query(
      'SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1',
      [tenant],
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('el secreto del webhook también, y el nombre de variable pasa', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        createChannelAccount(c, {
          tenantId: tenant,
          kind: 'webchat',
          name: 'Con el secreto pegado',
          credentialRef: 'ZAVU_API_KEY',
          webhookSecretRef: 'whsec_9f8e7d6c5b4a',
        }),
      ),
    ).rejects.toThrow(/NOMBRE de la variable/);

    const buena = await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'webchat',
        name: 'Como se hace',
        credentialRef: 'ZAVU_API_KEY',
        webhookSecretRef: 'ZAVU_WEBHOOK_SECRET',
      }),
    );
    expect(buena.credentialRef).toBe('ZAVU_API_KEY');
  });
});
