import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { createPipeline } from '@iaxti/module-crm';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de pagos (#60/#61): credenciales por referencia, tope del USER,
// el link viaja al chat, y el webhook público con firma.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let conversacion: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
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
  process.env.PAGOS_API_CRED = 'sandbox';
  process.env.PAGOS_API_SECRET = 'secreto-webhook';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-payments-api') RETURNING id");
  tenant = t.rows[0].id;
  // El tope del USER (matriz §23) vive en settings.pagos.
  await admin.query(
    `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{pagos}', '{"maxLinkClpUser": 100000}') WHERE id = $1`,
    [tenant],
  );
  for (const [userId, email, roleName] of [
    [duena, 'dueña@pagos.cl', 'ADMIN'],
    [vendedor, 'vende@pagos.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone: '+56977770202', channel: 'simulador', body: '¿cuánto es?' }),
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
  await admin.query(`DELETE FROM payment_links WHERE tenant_id = $1 AND status <> 'paid'`, [tenant]);
  for (const tabla of ['messages', 'conversations', 'contacts', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/payments (#60)', () => {
  it('conectar proveedores es del ADMIN; live está prohibido fuera de producción', async () => {
    expect(
      (await pedir(vendedor, '/payments/providers', { method: 'POST', body: JSON.stringify({ kind: 'simulado', name: 'X', credentialRef: 'VAR' }) })).status,
    ).toBe(403);

    const live = await pedir(duena, '/payments/providers', {
      method: 'POST',
      body: JSON.stringify({ kind: 'flow', name: 'Flow real', credentialRef: 'VAR', mode: 'live' }),
    });
    expect(live.status).toBe(400);
    expect((await live.json()).message).toContain('modo test');

    const ok = await pedir(duena, '/payments/providers', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'simulado',
        name: 'Simulador',
        credentialRef: 'PAGOS_API_CRED',
        webhookSecretRef: 'PAGOS_API_SECRET',
      }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).mode).toBe('test');
  });

  it('el USER cobra hasta su tope, y el link viaja al chat como mensaje', async () => {
    const grande = await pedir(vendedor, '/payments/links', {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversacion, amountClp: 500000, concept: 'Cobro grande' }),
    });
    expect(grande.status).toBe(400);
    expect((await grande.json()).message).toContain('tope');

    const ok = await pedir(vendedor, '/payments/links', {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversacion, amountClp: 45000, concept: 'Manicure gel' }),
    });
    expect(ok.status).toBe(201);
    const link = await ok.json();
    expect(link.status).toBe('sent'); // creado Y entregado al chat

    const msg = await admin.query(
      `SELECT body, delivery_status FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'out' ORDER BY seq DESC LIMIT 1`,
      [tenant, conversacion],
    );
    expect(msg.rows[0].body).toContain('45.000');
    expect(msg.rows[0].body).toContain('pagos-simulados');
    expect(msg.rows[0].delivery_status).toBe('sent');
  });

  it('el webhook público: firma buena encola, firma mala 401, desconocido 404', async () => {
    const provider = await admin.query('SELECT id FROM payment_providers WHERE tenant_id = $1', [tenant]);
    const link = await admin.query(`SELECT id FROM payment_links WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenant]);
    const body = JSON.stringify({ linkId: link.rows[0].id, status: 'paid', paymentId: 'sim-1' });
    const firma = createHmac('sha256', 'secreto-webhook').update(body).digest('hex');

    const ok = await fetch(`${base}/webhooks/payments/${provider.rows[0].id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Iaxti-Pay-Signature': firma },
      body,
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).queued).toBe(true);

    const mala = await fetch(`${base}/webhooks/payments/${provider.rows[0].id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Iaxti-Pay-Signature': 'chamullo' },
      body,
    });
    expect(mala.status).toBe(401);

    expect(
      (
        await fetch(`${base}/webhooks/payments/${randomUUID()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(404);
  });
});

describe('el tope de monto se puede configurar de verdad (#535)', () => {
  /**
   * `settings.pagos.maxLinkClpUser` se LEÍA desde el primer día y ninguna ruta
   * lo escribía: la única escritura del repo era el `UPDATE` crudo del
   * `beforeAll` de este mismo archivo. Por eso el test pasaba y el producto no.
   *
   * Así que el tope quedaba en null siempre, la guarda del módulo nunca
   * disparaba, y cualquier vendedor con rol USER podía emitir un link por el
   * monto que quisiera y mandarlo al chat del cliente en el mismo click —
   * mientras la matriz §23 y la pantalla de roles le prometían al dueño que
   * «hasta tope» lo protege.
   *
   * Estas pruebas escriben por la RUTA. Es la diferencia que importa.
   */
  it('el dueño lo escribe por la ruta y el vendedor queda topado', async () => {
    const guardado = await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: 50_000 }),
    });
    expect(guardado.status).toBe(200);
    expect((await guardado.json()).maxLinkClpUser).toBe(50_000);

    // Y se lee de vuelta: sin el GET, la pantalla no puede mostrar lo guardado.
    const leido = await (await pedir(duena, '/payments/ajustes')).json();
    expect(leido.maxLinkClpUser).toBe(50_000);

    const pasado = await pedir(vendedor, '/payments/links', {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversacion, amountClp: 80_000, concept: 'Pasado del tope' }),
    });
    expect(pasado.status).toBe(400);
    expect(JSON.stringify(await pasado.json())).toContain('supera tu tope');
  });

  it('el tope no pisa las otras claves de pagos', async () => {
    // `updateTenantSettings` hace `settings || patch`, que es merge de PRIMER
    // nivel: escribir `{ pagos: { maxLinkClpUser } }` a secas se llevaría
    // `paidStageName` y cualquier otra clave de pagos (#536).
    await admin.query(
      `UPDATE tenants SET settings = jsonb_set(settings, '{pagos,paidStageName}', '"Pagado"') WHERE id = $1`,
      [tenant],
    );
    await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: 30_000 }),
    });
    const fila = await admin.query('SELECT settings FROM tenants WHERE id = $1', [tenant]);
    const pagos = (fila.rows[0].settings as { pagos: Record<string, unknown> }).pagos;
    expect(pagos.paidStageName, 'se llevó la otra clave de pagos').toBe('Pagado');
    expect(pagos.maxLinkClpUser).toBe(30_000);
  });

  it('null lo saca, y entonces el vendedor vuelve a cobrar sin tope', async () => {
    // Quitar el tope tiene que ser posible: un negocio que lo puso por un mes
    // de promoción no puede quedar atado a él.
    const quitado = await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: null }),
    });
    expect(quitado.status).toBe(200);
    expect((await quitado.json()).maxLinkClpUser).toBeNull();

    const grande = await pedir(vendedor, '/payments/links', {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversacion, amountClp: 900_000, concept: 'Sin tope' }),
    });
    // Puede fallar por no haber proveedor configurado, pero NO por el tope.
    expect(JSON.stringify(await grande.json())).not.toContain('supera tu tope');
  });

  it('un tope de cero o negativo se rechaza con el mensaje del producto', async () => {
    // Un tope de 0 dejaría al vendedor sin poder cobrar nada y se vería como
    // «no tiene tope» en la pantalla: los dos son cero.
    for (const valor of [0, -5000]) {
      const r = await pedir(duena, '/payments/ajustes', {
        method: 'PUT',
        body: JSON.stringify({ maxLinkClpUser: valor }),
      });
      expect(r.status, `${valor} debería rechazarse`).toBe(400);
      expect((await r.json()).message).toContain('mayor que cero');
    }
  });

  it('el vendedor no puede cambiarse su propio tope', async () => {
    // Es lo mínimo: un tope que el topado puede subir no es un tope.
    const r = await pedir(vendedor, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: 999_999 }),
    });
    expect(r.status).toBe(403);
  });
});

describe('la etapa de pagado se puede configurar y se valida (#536)', () => {
  beforeAll(async () => {
    // El embudo del negocio: `confirm.ts` busca la etapa POR NOMBRE dentro del
    // embudo de la oportunidad, así que sin etapas no hay nada que configurar.
    await withTenant(admin, tenant, (c) =>
      createPipeline(c, {
        tenantId: tenant,
        name: 'Ventas',
        // Un embudo necesita al menos una abierta, una ganada y una perdida.
        stages: [
          { name: 'Propuesta', type: 'open' },
          { name: 'Pagado', type: 'won' },
          { name: 'No fue', type: 'lost' },
        ],
      }),
    );
  });

  /**
   * `settings.pagos.paidStageName` se leía en `confirm.ts` desde el principio y
   * ninguna ruta la escribía. El cliente pagaba, el comprobante se publicaba en
   * la conversación, y la oportunidad se quedaba en «Propuesta» para siempre: el
   * vendedor tenía que moverla a mano y nada se lo recordaba, así que el dueño
   * miraba el embudo y veía plata «por cerrar» que ya estaba en su cuenta.
   */
  it('se guarda, y dice en qué embudos va a mover la oportunidad', async () => {
    const disponibles = await (await pedir(duena, '/payments/ajustes')).json();
    expect(Array.isArray(disponibles.etapasDisponibles)).toBe(true);

    // Con una etapa que EXISTE en el embudo del negocio.
    const etapa = disponibles.etapasDisponibles.find((e: string) => e === 'Pagado');
    expect(etapa, 'el negocio de prueba necesita al menos una etapa').toBeTruthy();

    const r = await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: null, paidStageName: etapa }),
    });
    expect(r.status).toBe(200);
    const cuerpo = await r.json();
    expect(cuerpo.paidStageName).toBe(etapa);
    // Cuáles embudos la tienen: un negocio con dos embudos y la etapa en uno
    // solo merece saberlo al guardar, no descubrirlo cuando el otro no se movió.
    expect(cuerpo.enEmbudos.length).toBeGreaterThan(0);
  });

  it('una etapa que no existe se rechaza con las que sí, no en silencio', async () => {
    // `confirm.ts` la busca POR NOMBRE y si no calza no mueve nada ni avisa. Un
    // typo sería un embudo que nunca se actualiza y nadie sabría por qué.
    const r = await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: null, paidStageName: 'Cobrado y listo' }),
    });
    expect(r.status).toBe(400);
    const cuerpo = await r.json();
    expect(cuerpo.code).toBe('ETAPA_DESCONOCIDA');
    // Y dice cuáles tiene: un «no existe» sin la lista obliga a adivinar.
    expect(cuerpo.message).toContain('Las que tienes:');
  });

  it('null la apaga: mover el deal es cortesía, no obligación', async () => {
    const r = await pedir(duena, '/payments/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ maxLinkClpUser: null, paidStageName: null }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).paidStageName).toBeNull();
    const fila = await admin.query('SELECT settings FROM tenants WHERE id = $1', [tenant]);
    const pagos = (fila.rows[0].settings as { pagos?: Record<string, unknown> }).pagos ?? {};
    expect(pagos).not.toHaveProperty('paidStageName');
  });
});
