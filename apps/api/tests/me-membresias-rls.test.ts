import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, generateKeyPair, jwtVerify } from 'jose';
import { createPool, estadoRls, runMigrations } from '@iaxti/db';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { dbRoleResolver } from '../src/auth/role-resolver';

const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const role = `test_me_${randomUUID().replaceAll('-', '')}`;
const userA = randomUUID();
const userB = randomUUID();
let owner: Pool;
let safe: Pool;
let app: INestApplication;
let tenantA: string;
let tenantB: string;
let base: string;
let token: (user: string) => Promise<string>;

beforeAll(async () => {
  owner = createPool(url);
  await runMigrations(owner);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  safe = createPool(url.replace(/\/\/[^@]+@/, `//${role}:${role}@`));
  for (const [name, user] of [['me-a', userA], ['me-b', userB]]) {
    const id = (await owner.query('INSERT INTO tenants(name) VALUES($1) RETURNING id', [name])).rows[0].id;
    if (user === userA) tenantA = id;
    else tenantB = id;
    await owner.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
      SELECT $1,$2,id FROM roles WHERE base AND name='ADMIN'`, [id, user]);
  }
  usarPool(safe);
  const keys = await generateKeyPair('ES256');
  token = (user) => new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setSubject(user)
    .setIssuer('https://test.example/auth').setExpirationTime('5m').sign(keys.privateKey);
  app = await createApp({
    jwtVerify: async (jwt) => ({ userId: (await jwtVerify(jwt, keys.publicKey, { issuer: 'https://test.example/auth' })).payload.sub! }),
    resolveRole: dbRoleResolver(safe), resolvePlatformAdmin: async () => false,
  });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  usarPool(null);
  await safe?.end();
  await owner.query(`DROP OWNED BY ${role}`);
  await owner.query(`DROP ROLE ${role}`);
  await owner.end();
});

it('/me sin tenant obtiene solo la membresía del JWT y no acepta suplantación por parámetros', async () => {
  expect((await estadoRls(safe)).seSalta).toBe(false);
  expect((await fetch(`${base}/v1/me`)).status).toBe(401);
  for (const [user, tenantId, tenantName, other] of [[userA, tenantA, 'me-a', userB], [userB, tenantB, 'me-b', userA]]) {
    const response = await fetch(`${base}/v1/me?userId=${other}`, {
      headers: { Authorization: `Bearer ${await token(user)}`, 'X-User-Id': other },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: user, email: null, tenants: [{ tenantId, tenantName, roleName: 'ADMIN' }] });
  }
  const outsider = randomUUID();
  expect((await (await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${await token(outsider)}` } })).json()).tenants).toEqual([]);
  expect((await safe.query('SELECT * FROM user_roles')).rows).toEqual([]);
});
