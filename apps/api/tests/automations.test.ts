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

// La API del motor (#62): configurar es del ADMIN, mirar es de la
// supervisión, y la vista previa llega antes que el interruptor.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const supervisora = randomUUID(); // SUPERVISOR
const vendedor = randomUUID(); // USER

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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-automations-api') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@auto.cl', 'ADMIN'],
    [supervisora, 'sup@auto.cl', 'SUPERVISOR'],
    [vendedor, 'vende@auto.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56944440001', channel: 'simulador', body: 'hola' }),
  );
  await admin.query(
    `UPDATE conversations SET last_inbound_at = now() - interval '2 days' WHERE id = $1`,
    [res.conversation.id],
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
  for (const tabla of ['sequence_enrollments', 'sequences', 'rule_runs', 'rules', 'messages', 'conversations', 'contacts', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/automations (#62)', () => {
  it('configurar es del ADMIN; la SUPERVISORA mira; el USER nada', async () => {
    expect((await pedir(vendedor, '/automations')).status).toBe(403);
    expect(
      (await pedir(supervisora, '/automations/seed', { method: 'POST', body: JSON.stringify({ vertical: 'belleza' }) }))
        .status,
    ).toBe(403);

    const seed = await pedir(duena, '/automations/seed', {
      method: 'POST',
      body: JSON.stringify({ vertical: 'belleza' }),
    });
    expect(seed.status).toBe(201);
    expect(await seed.json()).toHaveLength(3);

    const lista = await (await pedir(supervisora, '/automations')).json();
    expect(lista).toHaveLength(3);
    expect(lista.every((r: { active: boolean }) => !r.active)).toBe(true);
  });

  it('regla inválida responde 400 con voz clara', async () => {
    const res = await pedir(duena, '/automations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Rota',
        trigger: { kind: 'time', time: { base: 'no_reply', hours: 0 } },
        actions: [{ kind: 'add_note', params: { body: 'x' } }],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('horas');
  });

  it('secuencias (#63): el ADMIN define, el VENDEDOR inscribe y ve la ficha', async () => {
    const negado = await pedir(vendedor, '/automations/sequences', {
      method: 'POST',
      body: JSON.stringify({ name: 'X', steps: [] }),
    });
    expect(negado.status).toBe(403);

    const creada = await pedir(duena, '/automations/sequences', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Seguimiento',
        steps: [
          { afterHours: 24, onlyIfNoReply: true, action: { kind: 'add_note', params: { body: 'Retomar.' } } },
        ],
      }),
    });
    expect(creada.status).toBe(201);
    const seq = await creada.json();

    // El vendedor lista y mete SU conversación (automations.enroll, §23).
    const lista = await (await pedir(vendedor, '/automations/sequences')).json();
    expect(lista.map((s: { id: string }) => s.id)).toContain(seq.id);

    const conv = await admin.query('SELECT id, contact_id FROM conversations WHERE tenant_id = $1 LIMIT 1', [tenant]);
    const inscrita = await pedir(vendedor, `/automations/sequences/${seq.id}/enroll`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: conv.rows[0].id }),
    });
    expect(inscrita.status).toBe(201);
    expect((await inscrita.json()).status).toBe('running');

    const ficha = await (
      await pedir(vendedor, `/automations/sequences/enrollments?contactId=${conv.rows[0].contact_id}`)
    ).json();
    expect(ficha[0]).toMatchObject({ status: 'running', sequenceName: 'Seguimiento', totalSteps: 1 });
  });

  it('la vista previa muestra a quién le aplicaría hoy, y el switch enciende', async () => {
    const lista = await (await pedir(duena, '/automations')).json();
    const sinRespuesta = lista.find((r: { name: string }) => r.name.includes('Sin respuesta'));

    const preview = await (await pedir(duena, `/automations/${sinRespuesta.id}/preview`)).json();
    expect(preview.length).toBe(1); // la conversación de hace 2 días

    const encendida = await pedir(duena, `/automations/${sinRespuesta.id}/active`, {
      method: 'POST',
      body: JSON.stringify({ active: true }),
    });
    expect(encendida.status).toBe(201);
    expect((await encendida.json()).active).toBe(true);

    expect((await pedir(supervisora, '/automations/runs')).status).toBe(200);
  });
});
