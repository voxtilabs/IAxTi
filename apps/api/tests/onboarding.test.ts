import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import { createPipeline } from '@iaxti/module-crm';
import { olvidarZonas } from '@iaxti/module-organizations';
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
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['conversations', 'contacts', 'channel_accounts', 'stages', 'pipelines', 'user_roles', 'invitations', 'outbox']) {
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

  /**
   * El detalle del primer mensaje se escribe en castellano y en la hora del
   * negocio (#1072).
   *
   * Las dos cosas se rompían juntas en la PORTADA, que es `app/page.tsx`: el
   * plural `conversación` + `es` daba «conversaciónes», y la fecha salía de
   * `toISOString()`, o sea UTC.
   *
   * El instante es FIJO y no `Date.now()`: 22:10 del 25 en Chile son las
   * 01:10 UTC del 26, así que con UTC la portada fechaba el último mensaje
   * un día en el futuro. Medir con el reloj de la máquina haría que esta
   * prueba solo pudiera fallar tres horas al día.
   */
  describe('el detalle de «Recibe tu primer mensaje» (#1072)', () => {
    const VEINTIDOS_DIEZ_EN_CHILE = new Date('2026-10-26T01:10:00.000Z');

    async function conDosConversaciones(): Promise<void> {
      await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
      await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
      const c = await admin.query(
        "INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Quien escribió') RETURNING id",
        [tenant],
      );
      // La segunda es la MÁS NUEVA y la que fecha el detalle: así se
      // comprueba que sale del `max(last_message_at)` y no de la primera.
      for (const cuando of [new Date(VEINTIDOS_DIEZ_EN_CHILE.getTime() - 86_400_000), VEINTIDOS_DIEZ_EN_CHILE]) {
        await admin.query(
          `INSERT INTO conversations (tenant_id, contact_id, channel, state, last_message_at)
           VALUES ($1, $2, 'whatsapp', 'open', $3)`,
          [tenant, c.rows[0].id, cuando],
        );
      }
    }

    async function detalleDelPaso(): Promise<string> {
      const e = await (await pedir(dueña)).json();
      return e.pasos.find((p: { id: string }) => p.id === 'first_message').detalle as string;
    }

    it('pluraliza sin la tilde y fecha con la zona del negocio', async () => {
      await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenant]);
      olvidarZonas();
      await conDosConversaciones();

      const detalle = await detalleDelPaso();
      expect(detalle).toContain('2 conversaciones');
      expect(detalle).not.toContain('conversaciónes');
      // En Chile ese instante es el 25 a las 22:10, no el 26.
      expect(detalle).toContain('la última el 2026-10-25');
      expect(detalle).not.toContain('2026-10-26');
    });

    it('con una sola, el singular sí lleva tilde', async () => {
      await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
      const c = await admin.query(
        "INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Una sola') RETURNING id",
        [tenant],
      );
      await admin.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel, state, last_message_at)
         VALUES ($1, $2, 'whatsapp', 'open', $3)`,
        [tenant, c.rows[0].id, VEINTIDOS_DIEZ_EN_CHILE],
      );

      const detalle = await detalleDelPaso();
      expect(detalle).toContain('1 conversación,');
      expect(detalle).not.toContain('conversaciones');
    });

    it('la zona del TENANT manda, no la del producto ni UTC', async () => {
      // Esta necesita OTRO instante, y el motivo vale escribirlo: para un
      // mismo instante solo existen dos días en todo el planeta, así que con
      // las 01:10 UTC de arriba cualquier zona da el 25 (como Chile) o el 26
      // (como UTC) — y una prueba que elija Auckland pasaría igual con el
      // defecto puesto, porque Auckland y UTC coinciden ahí. Lo comprobé
      // mordiendo el arreglo: pasaba en verde.
      //
      // Al mediodía UTC los tres se separan: UTC el 26, Chile el 26 a las
      // 09:00 y Auckland ya el 27 a la 01:00. Recién ahí la prueba puede
      // distinguir «siguió la zona del tenant» de las otras dos respuestas.
      const MEDIODIA_UTC = new Date('2026-10-26T12:00:00.000Z');
      await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
      const c = await admin.query(
        "INSERT INTO contacts (tenant_id, name) VALUES ($1, 'Al otro lado') RETURNING id",
        [tenant],
      );
      await admin.query(
        `INSERT INTO conversations (tenant_id, contact_id, channel, state, last_message_at)
         VALUES ($1, $2, 'whatsapp', 'open', $3)`,
        [tenant, c.rows[0].id, MEDIODIA_UTC],
      );

      await admin.query("UPDATE tenants SET timezone = 'Pacific/Auckland' WHERE id = $1", [tenant]);
      olvidarZonas();
      const detalle = await detalleDelPaso();
      expect(detalle).toContain('la última el 2026-10-27');
      // Ni la del producto ni UTC: las dos dirían el 26.
      expect(detalle).not.toContain('2026-10-26');

      await admin.query("UPDATE tenants SET timezone = 'America/Santiago' WHERE id = $1", [tenant]);
      olvidarZonas();
    });
  });

});
