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

// La API de la bandeja (#37): permisos por rol, verificación de dueño en el
// caso de uso, responder toma la conversación y el simulador entrega.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const dueña = randomUUID(); // ADMIN
const vendedor = randomUUID(); // USER
const colega = randomUUID(); // USER (dueño de una conversación ajena)
let enCola: string; // sin dueño
let deVendedor: string;
let deColega: string;

async function pedir(
  quien: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-bandeja') RETURNING id");
  tenant = t.rows[0].id;

  for (const [userId, email, roleName] of [
    [dueña, 'dueña@bandeja.cl', 'ADMIN'],
    [vendedor, 'vende@bandeja.cl', 'USER'],
    [colega, 'colega@bandeja.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

  // Tres conversaciones simuladas: en cola, del vendedor y del colega.
  const ids: string[] = [];
  for (const phone of ['+56922220001', '+56922220002', '+56922220003']) {
    const res = await withTenant(admin, tenant, (c) =>
      receiveInbound(c, { tenantId: tenant, phone, channel: 'simulador', body: 'hola' }),
    );
    ids.push(res.conversation.id);
  }
  [enCola, deVendedor, deColega] = ids;
  await admin.query('UPDATE conversations SET owner_id = $1, state = $2 WHERE id = $3', [vendedor, 'open', deVendedor]);
  await admin.query('UPDATE conversations SET owner_id = $1, state = $2 WHERE id = $3', [colega, 'open', deColega]);

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({ email: 'x@y.cl' })
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
  await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  // El tenant NO se borra: un 403 en el test deja su rastro en el libro de
  // auditoría (#71) y ese registro es best-effort, así que puede llegar
  // después de esta limpieza. Un tenant de prueba de más no le hace daño a
  // nadie; una carrera intermitente en CI, sí.
  await admin.end();
});

describe('GET /v1/conversations', () => {
  it('un USER ve las suyas y las sin dueño; jamás las de un colega', async () => {
    const res = await pedir(vendedor, '/conversations');
    expect(res.status).toBe(200);
    const { items } = await res.json();
    const ids = items.map((i: { id: string }) => i.id);
    expect(ids).toContain(enCola);
    expect(ids).toContain(deVendedor);
    expect(ids).not.toContain(deColega);
  });

  it('el ADMIN (read_all) ve todo; "mi cola" filtra por dueño', async () => {
    const todo = await (await pedir(dueña, '/conversations')).json();
    expect(todo.items).toHaveLength(3);

    const miCola = await (await pedir(vendedor, '/conversations?view=mi_cola')).json();
    expect(miCola.items.map((i: { id: string }) => i.id)).toEqual([deVendedor]);
  });

  it('"sin responder" ordena por la que más tiempo espera y trae el contador', async () => {
    const res = await (await pedir(dueña, '/conversations?view=sin_responder')).json();
    expect(res.items.length).toBeGreaterThanOrEqual(3);
    expect(res.items[0].id).toBe(enCola); // la primera creada espera más
    expect(res.items[0].unansweredSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('detalle y mensajes', () => {
  it('la conversación de un colega responde 404 (ni siquiera "existe")', async () => {
    expect((await pedir(vendedor, `/conversations/${deColega}`)).status).toBe(404);
    expect((await pedir(vendedor, `/conversations/${deColega}/messages`)).status).toBe(404);
    expect((await pedir(dueña, `/conversations/${deColega}`)).status).toBe(200);
  });

  it('la ficha trae contacto y estado', async () => {
    const detail = await (await pedir(vendedor, `/conversations/${deVendedor}`)).json();
    expect(detail.contactPhone).toBe('+56922220002');
    expect(detail.state).toBe('open');
  });
});

describe('responder, asignar, resolver', () => {
  it('responder desde la cola la toma (dueño + open) y el simulador entrega', async () => {
    const res = await pedir(vendedor, `/conversations/${enCola}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '¡Hola! ¿En qué te ayudo?' }),
    });
    expect(res.status).toBe(201);
    const mensaje = await res.json();
    expect(mensaje.deliveryStatus).toBe('sent'); // canal simulador

    const conv = await (await pedir(vendedor, `/conversations/${enCola}`)).json();
    expect(conv.ownerId).toBe(vendedor);
    expect(conv.state).toBe('open');
    expect(conv.firstResponseAt).not.toBeNull();
  });

  it('un USER no asigna (403); un ADMIN sí, con historial', async () => {
    const negado = await pedir(vendedor, `/conversations/${enCola}/assign`, {
      method: 'POST',
      body: JSON.stringify({ toOwnerId: colega }),
    });
    expect(negado.status).toBe(403);
    expect((await negado.json()).code).toBe('PERMISSION_DENIED');

    const ok = await pedir(dueña, `/conversations/${enCola}/assign`, {
      method: 'POST',
      body: JSON.stringify({ toOwnerId: colega, reason: 'balance de carga' }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).ownerId).toBe(colega);
  });

  it('resolver funciona y una transición inválida responde 400 con voz Pulso', async () => {
    const ok = await pedir(vendedor, `/conversations/${deVendedor}/state`, {
      method: 'POST',
      body: JSON.stringify({ state: 'resolved' }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).state).toBe('resolved');

    const malo = await pedir(vendedor, `/conversations/${deVendedor}/state`, {
      method: 'POST',
      body: JSON.stringify({ state: 'pending' }),
    });
    expect(malo.status).toBe(400);
    expect((await malo.json()).code).toBe('INVALID_TRANSITION');
  });
});
