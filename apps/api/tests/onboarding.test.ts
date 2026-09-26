import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import { createPipeline } from '@iaxti/module-crm';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// GET /v1/onboarding (#56): dónde va la puesta en marcha y qué falta, con lo
// que HAY — no solo con lo que la columna recuerda.
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const dueña = randomUUID();
const vendedor = randomUUID();

async function pedir(quien: string): Promise<Response> {
  return fetch(`${base}/v1/onboarding`, {
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-onboarding') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [dueña, 'duena@onb.cl', 'ADMIN'],
    [vendedor, 'vende@onb.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

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
  for (const tabla of ['channel_accounts', 'stages', 'pipelines', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('GET /v1/onboarding', () => {
  it('recién creado: dice qué sigue y por qué falta cada cosa', async () => {
    const res = await pedir(dueña);
    expect(res.status).toBe(200);
    const e = await res.json();
    expect(e.estadoRegistrado).toBe('registered');
    expect(e.completo).toBe(false);
    expect(e.siguiente).toBe('configured');
    // Los pasos vienen con su ayuda en la voz de Pulso: qué hay que hacer,
    // no un rótulo suelto que el frontend tenga que traducir.
    const conf = e.pasos.find((p: { id: string }) => p.id === 'configured');
    expect(conf.ayuda).toContain('Describe a qué te dedicas');
    expect(conf.detalle).toContain('todavía no hay embudo');
    expect(conf.fuente).toBe('verificado');
    // El equipo ya tiene a alguien más que la dueña: ese paso está hecho.
    const equipo = e.pasos.find((p: { id: string }) => p.id === 'team_invited');
    expect(equipo.hecho).toBe(true);
    expect(equipo.detalle).toContain('además de ti');
  });

  it('el simulador conectado NO marca el paso de WhatsApp', async () => {
    // Es lo que uno hace para probar sin número. Si contara, el flujo
    // guiado dejaría de pedir el número y el negocio nunca lo conecta.
    const cuenta = await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'simulador',
        // El id único va en el `name`, no en un `externalId`: ese campo no
        // existe en `createChannelAccount` y se caía, así que las cuentas de
        // simulador de dos pruebas quedaban idénticas.
        name: `Simulador sim-${randomUUID()}`,
      }),
    );
    await withTenant(admin, tenant, (c) =>
      setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }),
    );
    const e = await (await pedir(dueña)).json();
    const wa = e.pasos.find((p: { id: string }) => p.id === 'whatsapp_connected');
    expect(wa.hecho).toBe(false);
    expect(wa.detalle).toContain('todavía no hay número');
  });

  it('con el embudo y el número de verdad, avanza', async () => {
    await withTenant(admin, tenant, (c) =>
      createPipeline(c, {
        tenantId: tenant,
        name: 'Ventas',
        stages: [
          { name: 'Nuevo', type: 'open' },
          { name: 'Ganado', type: 'won' },
          { name: 'Perdido', type: 'lost' },
        ],
      }),
    );
    const cuenta = await withTenant(admin, tenant, (c) =>
      createChannelAccount(c, {
        tenantId: tenant,
        kind: 'whatsapp',
        // Igual que arriba: el id único va en el nombre, porque `externalId`
        // no existe en esta función y se caía sin avisar.
        name: `+56 9 1111 1111 wa-${randomUUID()}`,
      }),
    );
    await withTenant(admin, tenant, (c) =>
      setChannelState(c, { tenantId: tenant, accountId: cuenta.id, state: 'active' }),
    );
    const e = await (await pedir(dueña)).json();
    expect(e.pasos.find((p: { id: string }) => p.id === 'configured').hecho).toBe(true);
    const wa = e.pasos.find((p: { id: string }) => p.id === 'whatsapp_connected');
    expect(wa.hecho).toBe(true);
    expect(wa.detalle).toContain('1 número activo');
    // Lo único obligatorio que queda es el primer mensaje.
    expect(e.siguiente).toBe('first_message');
  });

  it('sin permiso de ajustes del tenant: 403 con el formato único', async () => {
    const res = await pedir(vendedor);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.requestId).toMatch(/^req_/);
  });
});
