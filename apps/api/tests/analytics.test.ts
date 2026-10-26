import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { bump } from '@iaxti/module-analytics';
import { olvidarZonas } from '@iaxti/module-organizations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de reportes (#66): sin read_all cada uno ve SOLO sus números.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const supervisora = randomUUID(); // SUPERVISOR
const vendedor = randomUUID(); // USER

async function pedir(quien: string, path: string): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-analytics-api') RETURNING id");
  tenant = t.rows[0].id;
  // El negocio real ya tiene su administrador antes de invitar al equipo (#902).
  await admin.query(`INSERT INTO user_roles(tenant_id,user_id,role_id)
    SELECT $1,$2,id FROM roles WHERE base AND name='ADMIN'`, [tenant, randomUUID()]);
  for (const [userId, email, roleName] of [
    [supervisora, 'sup@rep.cl', 'SUPERVISOR'],
    [vendedor, 'vende@rep.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  // Total del tenant: 5 resueltas; del vendedor: 2 (bump escribe ambas filas).
  await withTenant(admin, tenant, (c) => bump(c, { tenantId: tenant, metric: 'resueltas', value: 3 }));
  await withTenant(admin, tenant, (c) =>
    bump(c, { tenantId: tenant, metric: 'resueltas', value: 2, ownerId: vendedor }),
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
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['daily_metrics', 'response_samples', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/analytics/dashboard (#66)', () => {
  it('el USER ve SOLO sus números; la SUPERVISORA (read_all) el total', async () => {
    const propio = await (await pedir(vendedor, '/analytics/dashboard')).json();
    expect(propio.metrics.resueltas).toBe(2);

    const todo = await (await pedir(supervisora, '/analytics/dashboard')).json();
    expect(todo.metrics.resueltas).toBe(5);
    expect(todo.definiciones.resueltas).toContain('resueltas');

    // Pedir los números de un colega sin read_all: siempre los propios.
    const espiando = await (
      await pedir(vendedor, `/analytics/dashboard?ownerId=${supervisora}`)
    ).json();
    expect(espiando.metrics.resueltas).toBe(2);
  });

  it('rango inválido responde 400 con voz clara', async () => {
    const res = await pedir(supervisora, '/analytics/dashboard?from=2026-09-14&to=2026-01-01');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  /**
   * La ventana se resuelve con la zona del NEGOCIO (#1074).
   *
   * El navegador la armaba con `toISOString()` y mandaba `from`/`to` en UTC,
   * mientras el servidor archiva `daily_metrics.day` con `diaEn(zona, …)`.
   * Entre las 21:00 y la medianoche chilenas eso perdía el día más viejo de
   * la ventana y pedía uno que todavía no existe.
   *
   * Solo se finge `Date` —no los temporizadores— porque lo único que hay que
   * fijar es el instante que el controlador usa de ancla. Con el reloj de la
   * máquina esta prueba solo podría fallar tres horas al día.
   */
  describe('?dias=N resuelve la ventana en la zona del negocio (#1074)', () => {
    // 22:10 del 25 en Chile. En UTC ya es el 26.
    const LAS_22_10_EN_CHILE = new Date('2026-10-26T01:10:00.000Z');

    afterEach(async () => {
      vi.useRealTimers();
      await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenant]);
      olvidarZonas();
    });

    async function rangoDe(dias: number): Promise<{ from: string; to: string }> {
      const res = await pedir(supervisora, `/analytics/dashboard?dias=${dias}`);
      expect(res.status).toBe(200);
      return (await res.json()).rango;
    }

    it('a las 22:10 en Chile, 7 días son 10-19 … 10-25 y no 10-20 … 10-26', async () => {
      await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenant]);
      olvidarZonas();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(LAS_22_10_EN_CHILE);

      expect(await rangoDe(7)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
      // El 26 es el día que UTC habría pedido y todavía no existe para el
      // negocio: si aparece, los dos relojes volvieron.
      expect((await rangoDe(30)).to).toBe('2026-10-25');
    });

    it('la zona del TENANT manda, y no la del producto ni UTC', async () => {
      // Esta necesita OTRO instante, y el motivo vale escribirlo porque es
      // fácil caer: para un mismo instante existen solo DOS días en todo el
      // planeta, así que con las 01:10 UTC de arriba cualquier zona da el 25
      // (como Chile) o el 26 (como UTC) — y una prueba con Auckland pasaría
      // igual con el defecto puesto, porque Auckland y UTC coinciden ahí.
      // Comprobado mordiendo el arreglo: pasaba en verde.
      //
      // Al mediodía UTC los tres se separan: UTC el 26, Chile el 26 a las
      // 09:00 y Auckland ya el 27 a la 01:00.
      const MEDIODIA_UTC = new Date('2026-10-26T12:00:00.000Z');
      await admin.query("UPDATE tenants SET timezone = 'Pacific/Auckland' WHERE id = $1", [tenant]);
      olvidarZonas();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(MEDIODIA_UTC);

      const rango = await rangoDe(7);
      expect(rango.to).toBe('2026-10-27');
      // Ni la del producto ni UTC: las dos dirían el 26.
      expect(rango.to).not.toBe('2026-10-26');
      expect(rango.from).toBe('2026-10-21');
    });

    it('un from/to explícito se sigue respetando, y vuelve en la respuesta', async () => {
      const res = await pedir(supervisora, '/analytics/dashboard?from=2026-09-01&to=2026-09-07');
      expect(res.status).toBe(200);
      expect((await res.json()).rango).toEqual({ from: '2026-09-01', to: '2026-09-07' });
    });

    it('una cantidad de días que no se entiende es 400, no una ventana inventada', async () => {
      for (const malo of ['0', '-3', 'siete', '400', '7.5']) {
        const res = await pedir(supervisora, `/analytics/dashboard?dias=${malo}`);
        expect(res.status, `dias=${malo}`).toBe(400);
        expect((await res.json()).code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
