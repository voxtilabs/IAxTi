import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { costosDelCicloEnCurso, ensureSubscription } from '@iaxti/module-billing';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * La ampliación de IA contratada (#536).
 *
 * `buildInvoiceLines` tenía lista la línea «Ampliación de asistencias de IA
 * contratada» desde que se escribió, y el plan más alto se vende con «cuota de IA
 * ampliable» (SPEC §6). Pero `settings.billing.iaAmpliacionClp` no se podía
 * escribir por ninguna ruta, así que la línea nunca apareció en una factura: el
 * cliente que contrataba la ampliación no la pagaba.
 *
 * Esta prueba mira la FACTURA y no el ajuste. Comprobar que la clave quedó guardada
 * habría pasado igual con el bug en la línea de factura, y es lo que dejó pasar
 * estos cuatro ajustes: cada uno tenía quien lo leyera, y nadie miraba el efecto.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();
const superadmin = randomUUID();

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
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('test-ampliacion-ia', 'pro') RETURNING id",
  );
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@ampliacion.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));
  await withTenant(admin, tenant, (c) => ensureSubscription(c, tenant));

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
    resolvePlatformAdmin: async (userId) => userId === superadmin,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['audit_log', 'invoices', 'subscriptions', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]).catch(() => {});
  }
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

async function lineas() {
  const costos = await withTenant(admin, tenant, (c) => costosDelCicloEnCurso(c, tenant));
  return costos?.lines ?? [];
}

describe('la ampliación de IA se puede contratar y se factura (#536)', () => {
  it('sin contratarla, la factura no trae la línea', async () => {
    expect((await lineas()).some((l) => l.concepto === 'ampliacion_ia')).toBe(false);
  });

  it('el ADMIN del negocio NO la puede fijar: es un cargo, no una preferencia', async () => {
    // Si un ADMIN pudiera moverlo estaría editando su propia factura.
    const r = await pedir(duena, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 1 }),
    });
    expect(r.status).toBe(403);
  });

  it('el SuperAdmin la fija y la línea APARECE en la factura con su monto', async () => {
    const r = await pedir(superadmin, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 35000 }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).iaAmpliacionClp).toBe(35000);

    const linea = (await lineas()).find((l) => l.concepto === 'ampliacion_ia');
    expect(linea, 'la línea de la factura es lo que importa, no la clave guardada').toBeTruthy();
    expect(linea!.amountClp).toBe(35000);
    expect(linea!.detalle).toContain('Ampliación');
  });

  it('no pisa lo que ya había en billing', async () => {
    // `jsonb_set` con el objeto entero se llevaría cualquier otra clave de ahí, y
    // es como se perdieron ajustes antes: dos rutas parchando el mismo primer nivel.
    await admin.query(
      `UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{billing}',
         COALESCE(settings->'billing','{}'::jsonb) || '{"vecina":"no me toques"}'::jsonb)
        WHERE id = $1`,
      [tenant],
    );
    await pedir(superadmin, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 40000 }),
    });
    const fila = await admin.query(
      `SELECT settings->'billing' AS billing FROM tenants WHERE id = $1`,
      [tenant],
    );
    expect(fila.rows[0].billing.vecina).toBe('no me toques');
    expect(Number(fila.rows[0].billing.iaAmpliacionClp)).toBe(40000);
  });

  it('con null se da de baja y la línea desaparece', async () => {
    const r = await pedir(superadmin, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: null }),
    });
    expect(r.status).toBe(200);
    expect((await lineas()).some((l) => l.concepto === 'ampliacion_ia')).toBe(false);
  });

  it('un cero se rechaza: en una factura no es lo mismo que no cobrar', async () => {
    // «Se cobró $0» y «no se cobró» son cosas distintas para quien lee una factura.
    const r = await pedir(superadmin, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 0 }),
    });
    expect(r.status).toBe(400);
    const cuerpo = await r.json();
    expect(cuerpo.code).toBe('VALIDATION_ERROR');
    // Y el mensaje dice qué hacer, no «expected positive number».
    expect(cuerpo.message).toContain('null');
  });

  it('queda en audit_log, en la misma transacción, con el monto de antes y el de ahora', async () => {
    await pedir(superadmin, `/platform/tenants/${tenant}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 50000 }),
    });
    const r = await admin.query(
      `SELECT actor, action, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'billing.ampliacion_ia.cambiada'
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [tenant],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe(superadmin);
    // De cuánto a cuánto: un registro con solo el valor nuevo no permite
    // reconstruir una factura que no cuadra.
    expect(r.rows[0].metadata.antesClp).toBeNull();
    expect(r.rows[0].metadata.ahoraClp).toBe(50000);
  });

  it('un tenant que no existe responde 404 y no crea nada', async () => {
    const r = await pedir(superadmin, `/platform/tenants/${randomUUID()}/ampliacion-ia`, {
      method: 'PUT',
      body: JSON.stringify({ montoClp: 1000 }),
    });
    expect(r.status).toBe(404);
  });
});
