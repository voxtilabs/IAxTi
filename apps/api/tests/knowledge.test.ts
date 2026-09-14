import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { addSource, processSource, type EmbedPort } from '@iaxti/module-knowledge';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API del conocimiento (#51): gestionar es del ADMIN, consultar el
// catálogo es del equipo, y sin llave de embeddings se avisa claro.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const vendedor = randomUUID(); // USER

const fakeEmbed: EmbedPort = {
  async embed(texts) {
    return texts.map(() => new Array(768).fill(0.01));
  },
};

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-knowledge-api') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@know.cl', 'ADMIN'],
    [vendedor, 'vende@know.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

  // El catálogo directo por contract (la API de agregar exige llave de
  // embeddings, que este ambiente no tiene — eso también se prueba).
  const s = await withTenant(admin, tenant, (c) =>
    addSource(c, {
      tenantId: tenant,
      kind: 'catalogo',
      name: 'Catálogo',
      content: 'nombre,precio,stock\nManicure gel,18000,5',
      actor: 'test',
    }),
  );
  await withTenant(admin, tenant, (c) =>
    processSource(c, { tenantId: tenant, sourceId: s.id }, { embed: fakeEmbed }),
  );

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['knowledge_query_cache', 'chunks', 'products', 'sources', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/knowledge (#51)', () => {
  it('gestionar fuentes es del ADMIN; el USER ni las ve', async () => {
    expect((await pedir(vendedor, '/knowledge/sources')).status).toBe(403);
    const res = await pedir(duena, '/knowledge/sources');
    expect(res.status).toBe(200);
    const fuentes = await res.json();
    expect(fuentes[0]).toMatchObject({ name: 'Catálogo', status: 'active' });
    expect(fuentes[0].chunkCount).toBe(1);
  });

  it('sin llave de embeddings, agregar avisa claro (503) — no adivina', async () => {
    const res = await pedir(duena, '/knowledge/sources', {
      method: 'POST',
      body: JSON.stringify({ kind: 'texto', name: 'Políticas', content: 'Atendemos de 10 a 19.' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');

    const malo = await pedir(duena, '/knowledge/sources', {
      method: 'POST',
      body: JSON.stringify({ kind: 'pergamino', name: 'X' }),
    });
    expect(malo.status).toBe(400);
  });

  it('get_product es del equipo: precio y stock como CAMPOS', async () => {
    const res = await pedir(vendedor, '/knowledge/products?q=manicure');
    expect(res.status).toBe(200);
    const productos = await res.json();
    expect(productos[0]).toMatchObject({ name: 'Manicure gel', price: 18000, stock: 5 });
  });

  it('eliminar una fuente arrasa con su índice', async () => {
    const [fuente] = await (await pedir(duena, '/knowledge/sources')).json();
    const res = await pedir(duena, `/knowledge/sources/${fuente.id}`, { method: 'DELETE' });
    expect((await res.json()).deleted).toBe(true);
    expect((await pedir(duena, `/knowledge/sources/${fuente.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});
