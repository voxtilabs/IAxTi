import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// Equipo en la bandeja (#39): atajos, notas, búsqueda y adjuntos por tenant.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let conversacion: string;
let firmar: (sub: string) => Promise<string>;
const supervisora = randomUUID();
const vendedor = randomUUID();

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
  // Adjuntos: config falsa de R2 para probar el prefijo por tenant.
  process.env.R2_ENDPOINT = 'https://cuenta.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.R2_SECRET_ACCESS_KEY = 'secreto';
  process.env.R2_BUCKET_ADJUNTOS = 'adjuntos-test';

  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-equipo') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [supervisora, 'sup@equipo.cl', 'SUPERVISOR'],
    [vendedor, 'vende@equipo.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56950000001', channel: 'simulador', body: 'hola' }),
  );
  conversacion = res.conversation.id;

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
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_ADJUNTOS;
  await admin.query('DELETE FROM internal_notes WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM quick_replies WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('quick replies', () => {
  it('el USER crea los suyos; los del negocio exigen quickreplies.manage', async () => {
    const mio = await pedir(vendedor, '/quick-replies', {
      method: 'POST',
      body: JSON.stringify({ shortcut: 'firma', body: 'Saludos', scope: 'mio' }),
    });
    expect(mio.status).toBe(201);

    const negado = await pedir(vendedor, '/quick-replies', {
      method: 'POST',
      body: JSON.stringify({ shortcut: 'oficial', body: 'Hola {nombre}', scope: 'negocio' }),
    });
    expect(negado.status).toBe(403);

    const oficial = await pedir(supervisora, '/quick-replies', {
      method: 'POST',
      body: JSON.stringify({ shortcut: 'oficial', body: 'Hola {nombre}', scope: 'negocio' }),
    });
    expect(oficial.status).toBe(201);

    const lista = await (await pedir(vendedor, '/quick-replies')).json();
    expect(lista.map((q: { shortcut: string }) => q.shortcut).sort()).toEqual(['firma', 'oficial']);
  });
});

describe('notas y búsqueda', () => {
  it('la nota se guarda con menciones y se lee con conversations.notes', async () => {
    const res = await pedir(vendedor, `/conversations/${conversacion}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Pidió factura urgente', mentions: [supervisora] }),
    });
    expect(res.status).toBe(201);
    const notas = await (await pedir(supervisora, `/conversations/${conversacion}/notes`)).json();
    expect(notas).toHaveLength(1);
    expect(notas[0].mentions).toEqual([supervisora]);
  });

  it('la búsqueda respeta la visibilidad: el USER no ve lo de colegas', async () => {
    await admin.query('UPDATE conversations SET owner_id = $2 WHERE id = $1', [conversacion, supervisora]);
    const deVendedor = await (await pedir(vendedor, '/search?q=factura')).json();
    expect(deVendedor).toEqual([]); // la conversación es de la supervisora
    const deSupervisora = await (await pedir(supervisora, '/search?q=factura')).json();
    expect(deSupervisora.some((h: { kind: string }) => h.kind === 'nota')).toBe(true);
  });
});

describe('adjuntos por tenant (R2)', () => {
  it('la subida se prefirma bajo el prefijo del tenant', async () => {
    const res = await pedir(vendedor, `/conversations/${conversacion}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ filename: 'presupuesto.pdf' }),
    });
    expect(res.status).toBe(201);
    const { key, uploadUrl } = await res.json();
    expect(key.startsWith(`${tenant}/${conversacion}/`)).toBe(true);
    expect(uploadUrl).toContain('X-Amz-Signature=');
    expect(uploadUrl).toContain('/adjuntos-test/');
  });

  it('bajar fuera del prefijo del tenant responde 404', async () => {
    const ajeno = await pedir(vendedor, `/attachments/url?key=${randomUUID()}/x/archivo.pdf`);
    expect(ajeno.status).toBe(404);
    const propio = await pedir(vendedor, `/attachments/url?key=${tenant}/${conversacion}/archivo.pdf`);
    expect(propio.status).toBe(200);
    expect((await propio.json()).url).toContain('X-Amz-Signature=');
  });
});
