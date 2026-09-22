import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * Elegir la plantilla del recordatorio (#59).
 *
 * El barrido de recordatorios existía completo y estaba cableado para no
 * mandar nada: le faltaba saber QUÉ plantilla usar. Esto es esa decisión, y
 * lo que más importa es que no se pueda elegir una plantilla sin aprobar —
 * un recordatorio con una plantilla pendiente no sale, y el negocio se
 * entera cuando alguien no llegó a su hora.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();
const vendedor = randomUUID();
let aprobada: string;
let pendiente: string;

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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-recordatorios') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@recordatorios.cl', 'ADMIN'],
    [vendedor, 'vende@recordatorios.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const ap = await admin.query(
    // `variables` no es columna: se deduce del cuerpo ({{1}}, {{2}}).
    `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status)
     VALUES ($1, 'recordatorio_cita', 'es', 'utility', 'Hola {{1}}, te esperamos el {{2}}.', 'approved')
     RETURNING id`,
    [tenant],
  );
  aprobada = ap.rows[0].id;
  const pe = await admin.query(
    `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status)
     VALUES ($1, 'recordatorio_nuevo', 'es', 'utility', 'Hola {{1}}.', 'pending')
     RETURNING id`,
    [tenant],
  );
  pendiente = pe.rows[0].id;

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
  for (const tabla of ['whatsapp_templates', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/agenda/recordatorios (#59)', () => {
  it('nace sin recordatorio, y solo ofrece plantillas APROBADAS', async () => {
    const res = await pedir(duena, '/agenda/recordatorios');
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.activo).toBe(false);
    expect(cuerpo.recordatorios).toEqual({ '24h': null, '2h': null });
    // La pendiente no se ofrece: elegirla es un recordatorio que no sale.
    expect(cuerpo.plantillas.map((p: { id: string }) => p.id)).toEqual([aprobada]);
  });

  it('elegir una pendiente se rechaza con el motivo', async () => {
    const res = await pedir(duena, '/agenda/recordatorios', {
      method: 'PUT',
      body: JSON.stringify({ '2h': pendiente }),
    });
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.code).toBe('PLANTILLA_NO_APROBADA');
    expect(cuerpo.message).toContain('no sale');
  });

  it('se puede configurar SOLO el de dos horas', async () => {
    // Muchos negocios consideran molesto el de 24 h. Tener que aceptar los
    // dos o ninguno haría que no configuraran ninguno.
    const res = await pedir(duena, '/agenda/recordatorios', {
      method: 'PUT',
      body: JSON.stringify({ '2h': aprobada }),
    });
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.recordatorios).toEqual({ '24h': null, '2h': aprobada });
    expect(cuerpo.activo).toBe(true);
  });

  it('quitarlo lo deja inactivo, y no rompe nada', async () => {
    const res = await pedir(duena, '/agenda/recordatorios', {
      method: 'PUT',
      body: JSON.stringify({ '24h': null, '2h': null }),
    });
    expect((await res.json()).activo).toBe(false);
  });

  it('configurar la agenda no es de cualquiera', async () => {
    expect((await pedir(vendedor, '/agenda/recordatorios')).status).toBe(403);
    expect(
      (await pedir(vendedor, '/agenda/recordatorios', { method: 'PUT', body: '{}' })).status,
    ).toBe(403);
  });
});
