import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, withTenant } from '@iaxti/db';
import { createChannelAccount } from '../application/accounts';
import { reservarEmisor } from '../application/senders';

// Base efímera: aplica el SQL real contra cuentas anteriores a #74, sin tocar
// las tablas ni fixtures que otros tests usan en la base de la suite.
const nombre = `iaxti_mig74_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!);
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = createPool(adminUrl.toString());
url.pathname = `/${nombre}`; const db = createPool(url.toString());
const migracion = readFileSync(resolve(__dirname, '../migrations/0004_emisor_compartido.sql'), 'utf8');
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${nombre}"`);
  await db.query('CREATE TABLE tenants(id uuid PRIMARY KEY)');
  await db.query(readFileSync(resolve(__dirname, '../migrations/0001_channels.sql'), 'utf8'));
});
afterAll(async () => { await db.end(); await admin.query(`DROP DATABASE "${nombre}" WITH (FORCE)`); await admin.end(); });
it('no inventa receptor para dos cuentas históricas del mismo sender y conserva ambas', async () => {
  const tenant = randomUUID(); await db.query('INSERT INTO tenants(id) VALUES($1)', [tenant]);
  const filas = await db.query(`INSERT INTO channel_accounts(tenant_id,kind,name,state,credential_ref,webhook_secret_ref,config)
    VALUES ($1,'instagram','Primera','active','TEST_KEY','TEST_HOOK','{"senderId":"ambiguo"}'),
           ($1,'instagram','Receptor real en Zavu','active','TEST_KEY','TEST_HOOK','{"senderId":"ambiguo"}'),
           ($1,'messenger','Única','active','TEST_KEY','TEST_HOOK','{"senderId":"unico"}') RETURNING *`, [tenant]);
  await db.query(migracion);
  expect((await db.query('SELECT * FROM channel_senders ORDER BY sender_id')).rows).toEqual([
    { sender_id: 'ambiguo', tenant_id: tenant, webhook_account_id: null },
    { sender_id: 'unico', tenant_id: tenant, webhook_account_id: filas.rows[2].id },
  ]);
  expect((await db.query("SELECT tenant_de_emisor_de_canal('ambiguo') AS owner")).rows[0].owner).toBe(tenant);
  await expect(withTenant(db, tenant, async (c) => {
    const cuenta = await createChannelAccount(c, { tenantId: tenant, kind: 'messenger', name: 'No debe quedar', credentialRef: 'TEST_KEY', webhookSecretRef: 'TEST_HOOK', config: { senderId: 'ambiguo' } });
    await reservarEmisor(c, { tenantId: tenant, senderId: 'ambiguo', accountId: cuenta.id });
  })).rejects.toThrow('Su receptor debe ser comprobado');
  expect((await db.query('SELECT * FROM channel_accounts ORDER BY name')).rows).toEqual([...filas.rows].sort((a,b) => a.name.localeCompare(b.name)));
  expect((await db.query("SELECT proconfig FROM pg_proc WHERE proname='tenant_de_emisor_de_canal'")).rows[0].proconfig).toEqual(['search_path=pg_catalog, public', 'row_security=off']);
  const c = await db.connect();
  try {
    await c.query('CREATE TEMP TABLE channel_senders(sender_id text, tenant_id uuid)');
    await c.query("INSERT INTO pg_temp.channel_senders VALUES('ambiguo',$1)", [randomUUID()]);
    expect((await c.query("SELECT tenant_de_emisor_de_canal('ambiguo') AS owner")).rows[0].owner).toBe(tenant);
  } finally { await c.query('DROP TABLE IF EXISTS pg_temp.channel_senders'); c.release(); }
});
