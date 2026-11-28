import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound, updateDeliveryStatus } from '@iaxti/module-conversations';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API de la difusión (#1247): dos pasos obligatorios, idempotencia, y el
// 403 con el formato único para quien no tiene el permiso de escribirle a
// todos.

const ISSUER = 'https://test.supabase.local/auth/v1';
const TEXTO = 'Gracias por venir al stand. Acá quedamos: iaxti.cl';

let app: INestApplication;
let base: string;
let admin: Pool;
let firmar: (sub: string) => Promise<string>;

/** Los negocios de prueba: uno por test, para no contar las conversaciones del de al lado. */
const tenants: string[] = [];

interface Prueba {
  tenant: string;
  /** Pide a la API como el ADMIN de este negocio. */
  comoAdmin: (path: string, init?: RequestInit) => Promise<Response>;
  /** Pide a la API como el USER de este negocio. */
  comoUser: (path: string, init?: RequestInit) => Promise<Response>;
  /** Otro negocio ajeno, con su propio ADMIN. */
  elOtro: (path: string, init?: RequestInit) => Promise<Response>;
}

async function crearTenant(nombre: string, members: Array<[string, string, string]>) {
  const tenant = (
    await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [nombre])
  ).rows[0].id;
  for (const [userId, email, roleName] of members) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }
  return tenant;
}

/**
 * Un negocio nuevo con ADMIN, USER y un vecino ajeno. Cada prueba parte de
 * cero: sin esto las conversaciones de los tests anteriores entraban a la
 * previa de los siguientes — «total 2» daba 10, y no por un defecto del envío.
 */
async function negocioParaProbar(): Promise<Prueba> {
  const n = tenants.length;
  const dueña = randomUUID();
  const vendedor = randomUUID();
  const vecina = randomUUID();
  const tenant = await crearTenant(`difusion-api-${n}`, [
    [dueña, `duena-${n}@difusion.cl`, 'ADMIN'],
    [vendedor, `vende-${n}@difusion.cl`, 'USER'],
  ]);
  const vecino = await crearTenant(`difusion-vecino-${n}`, [
    [vecina, `vecina-${n}@difusion.cl`, 'ADMIN'],
  ]);
  tenants.push(tenant, vecino);
  const pedir = (quien: string, de: string) => async (path: string, init: RequestInit = {}) =>
    fetch(`${base}/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await firmar(quien)}`,
        'X-Tenant-Id': de,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  return {
    tenant,
    comoAdmin: pedir(dueña, tenant),
    comoUser: pedir(vendedor, tenant),
    elOtro: pedir(vecina, vecino),
  };
}

/** Una conversación de WhatsApp de este tenant, con entrante hace un rato. */
async function conversacion(tenant: string, phone: string, opts: { haceHoras?: number } = {}) {
  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, { tenantId: tenant, phone, channel: 'whatsapp', body: 'gracias por todo' }),
  );
  if (opts.haceHoras !== undefined) {
    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() - ($2 || ' hours')::interval
        WHERE tenant_id = $1 AND id = $3`,
      [tenant, String(opts.haceHoras), res.conversation.id],
    );
  }
  return res.conversation.id;
}

/** La previsualización, por la ruta. */
async function previa(p: Prueba, texto = TEXTO): Promise<{ id: string; total: number }> {
  const res = await p.comoAdmin('/conversations/difusion/previa', {
    method: 'POST',
    body: JSON.stringify({ texto }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

/** El envío, con su Idempotency-Key. */
async function enviar(p: Prueba, previaId: string): Promise<Response> {
  return p.comoAdmin('/conversations/difusion', {
    method: 'POST',
    body: JSON.stringify({ previaId }),
    headers: { 'Idempotency-Key': randomUUID() },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
  admin = createPool();
  await runMigrations(admin);

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
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app.close();
  for (const tenant of tenants) {
    await admin.query('DELETE FROM difusion_destinatarios WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM difusiones WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
    // El tenant no se borra: audit_log lo referencia y es append-only.
  }
  await admin.end();
});

describe('POST /v1/conversations/difusion/previa', () => {
  it('es del ADMIN: un USER recibe 403 con el formato único', async () => {
    const p = await negocioParaProbar();
    const res = await p.comoUser('/conversations/difusion/previa', {
      method: 'POST',
      body: JSON.stringify({ texto: TEXTO }),
    });
    expect(res.status).toBe(403);
    const cuerpo = await res.json();
    expect(cuerpo.code).toBe('PERMISSION_DENIED');
    expect(cuerpo.message).toBeTruthy();
    expect(typeof cuerpo.requestId).toBe('string');
    expect(Array.isArray(cuerpo.details)).toBe(true);
  });

  it('no manda nada y dice cuántos quedan fuera y por qué', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944410001');
    await conversacion(p.tenant, '+56944410002');
    await conversacion(p.tenant, '+56944410003', { haceHoras: 30 });
    await conversacion(p.tenant, '+56944410004');
    await admin.query('UPDATE contacts SET opted_out_at = now() WHERE tenant_id=$1 AND phone=$2', [p.tenant, '+56944410004']);

    const res = await p.comoAdmin('/conversations/difusion/previa', {
      method: 'POST',
      body: JSON.stringify({ texto: TEXTO }),
    });
    expect(res.status).toBe(200);
    const previa = await res.json();
    expect(previa.total).toBe(2);
    expect(previa.texto).toBe(TEXTO);
    expect(previa.fuera).toContainEqual({ motivo: 'ventana cerrada', n: 1 });
    expect(previa.fuera).toContainEqual({ motivo: 'se dio de baja', n: 1 });
    expect(previa.id).toMatch(/^[0-9a-f-]{36}$/);
    // No se mandó nada.
    const out = await admin.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND direction='out'", [p.tenant]);
    expect(out.rows[0].n).toBe(0);
  });
});

describe('POST /v1/conversations/difusion', () => {
  it('sin Idempotency-Key no sale: 400 con qué hacer', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944420001');
    const { id } = await previa(p);

    const res = await p.comoAdmin('/conversations/difusion', {
      method: 'POST',
      body: JSON.stringify({ previaId: id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('crea un mensaje por destinatario, encolado por el camino del negocio', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944430001');
    await conversacion(p.tenant, '+56944430002');
    const { id } = await previa(p);

    const res = await enviar(p, id);
    expect(res.status).toBe(201);
    const envio = await res.json();
    expect(envio.total).toBe(2);

    const mensajes = await admin.query(
      `SELECT m.* FROM messages m JOIN difusion_destinatarios dt ON dt.message_id = m.id
        WHERE m.tenant_id=$1 AND dt.difusion_id=$2`,
      [p.tenant, id],
    );
    expect(mensajes.rows).toHaveLength(2);
    for (const m of mensajes.rows) {
      expect(m.delivery_status).toBe('queued');
      expect((m.meta as Record<string, unknown>).difusion).toMatchObject({ id });
    }
    // La política del pedido durable es `business`: el consumidor del outbox
    // la traduce a initiatedByBusiness=true y SIN transaccional.
    const eventos = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'
         AND payload->>'messageId' IN (SELECT message_id::text FROM difusion_destinatarios WHERE difusion_id=$2)`,
      [p.tenant, id],
    );
    expect(eventos.rows).toHaveLength(2);
    expect(eventos.rows.every((e) => e.payload.policy === 'business')).toBe(true);
  });

  it('la misma Idempotency-Key dos veces manda UNA sola vez', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944440001');
    await conversacion(p.tenant, '+56944440002');
    const { id } = await previa(p);

    const llave = randomUUID();
    const cuerpo = JSON.stringify({ previaId: id });
    const primera = await p.comoAdmin('/conversations/difusion', {
      method: 'POST', body: cuerpo, headers: { 'Idempotency-Key': llave },
    });
    expect(primera.status).toBe(201);
    const segunda = await p.comoAdmin('/conversations/difusion', {
      method: 'POST', body: cuerpo, headers: { 'Idempotency-Key': llave },
    });
    expect(segunda.status).toBe(201);
    expect(segunda.headers.get('idempotent-replay')).toBe('true');
    await expect(primera.json()).resolves.toEqual(await segunda.json());

    const mensajes = await admin.query(
      `SELECT count(*)::int AS n FROM messages m JOIN difusion_destinatarios dt ON dt.message_id = m.id
        WHERE m.tenant_id=$1 AND dt.difusion_id=$2`,
      [p.tenant, id],
    );
    expect(mensajes.rows[0].n).toBe(2);
  });

  it('quien se dio de baja ENTRE la previa y el envío no recibe', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944450001');
    await conversacion(p.tenant, '+56944450002');
    const { id } = await previa(p);
    await admin.query('UPDATE contacts SET opted_out_at = now() WHERE tenant_id=$1 AND phone=$2', [p.tenant, '+56944450001']);

    const res = await enviar(p, id);
    expect(res.status).toBe(201);
    const envio = await res.json();
    expect(envio.total).toBe(1);
    expect(envio.fuera).toEqual([{ motivo: 'se dio de baja', n: 1 }]);
    const salientes = await admin.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id=$1 AND direction='out' AND conversation_id IN (
          SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id
           WHERE c.tenant_id=$1 AND k.phone='+56944450001')`,
      [p.tenant],
    );
    expect(salientes.rows[0].n).toBe(0);
  });
});

describe('GET /v1/conversations/difusion/:id', () => {
  it('muestra por destinatario la entrega y el motivo del fallo', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944460001');
    await conversacion(p.tenant, '+56944460002');
    const { id } = await previa(p);
    await enviar(p, id);

    // Uno llega, el otro falla con su motivo.
    const destinatarios = await admin.query(
      `SELECT dt.message_id, k.phone FROM difusion_destinatarios dt
         JOIN contacts k ON k.id = dt.contact_id
        WHERE dt.tenant_id=$1 AND dt.difusion_id=$2`,
      [p.tenant, id],
    );
    const porTelefono = new Map(destinatarios.rows.map((r) => [r.phone, r.message_id]));
    await withTenant(admin, p.tenant, (c) =>
      updateDeliveryStatus(c, { tenantId: p.tenant, messageId: porTelefono.get('+56944460001'), status: 'sent', providerMessageId: 'wamid.dif.ok' }),
    );
    await withTenant(admin, p.tenant, (c) =>
      updateDeliveryStatus(c, { tenantId: p.tenant, messageId: porTelefono.get('+56944460002'), status: 'failed', error: 'El canal rechazó el mensaje.' }),
    );

    const res = await p.comoAdmin(`/conversations/difusion/${id}`);
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.estado).toBe('enviada');
    expect(r.total).toBe(2);
    const entregado = r.destinatarios.find((d: { telefono: string }) => d.telefono === '+56944460001');
    const fallido = r.destinatarios.find((d: { telefono: string }) => d.telefono === '+56944460002');
    expect(entregado.deliveryStatus).toBe('sent');
    expect(entregado.error).toBeNull();
    expect(fallido.deliveryStatus).toBe('failed');
    expect(fallido.error).toBe('El canal rechazó el mensaje.');
  });

  it('otro negocio no ve el envío: 404 sin confirmar que ahí hay algo', async () => {
    const p = await negocioParaProbar();
    await conversacion(p.tenant, '+56944470001');
    const { id } = await previa(p);
    const res = await p.elOtro(`/conversations/difusion/${id}`);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('DIFUSION_NOT_FOUND');
  });
});

describe('POST /v1/conversations/difusion/:id/reintentar', () => {
  it('reencola SOLO los fallidos: a quien recibió no se le vuelve a mandar', async () => {
    const p = await negocioParaProbar();
    const c1 = await conversacion(p.tenant, '+56944480001'); // recibió
    const c2 = await conversacion(p.tenant, '+56944480002'); // falló
    const { id } = await previa(p);
    await enviar(p, id);

    const destinatarios = await admin.query(
      `SELECT dt.conversation_id, dt.message_id FROM difusion_destinatarios dt
        WHERE dt.tenant_id=$1 AND dt.difusion_id=$2`,
      [p.tenant, id],
    );
    const porConversacion = new Map(destinatarios.rows.map((r) => [r.conversation_id, r.message_id]));
    await withTenant(admin, p.tenant, (c) =>
      updateDeliveryStatus(c, { tenantId: p.tenant, messageId: porConversacion.get(c1), status: 'sent', providerMessageId: 'wamid.dif.r.ok' }),
    );
    await withTenant(admin, p.tenant, (c) =>
      updateDeliveryStatus(c, { tenantId: p.tenant, messageId: porConversacion.get(c2), status: 'failed', error: 'El canal rechazó el mensaje.' }),
    );

    const res = await p.comoAdmin(`/conversations/difusion/${id}/reintentar`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect((await res.json()).reintentados).toBe(1);

    // Quien recibió quedó con UN solo mensaje saliente.
    const delQueRecibio = await admin.query(
      "SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='out'",
      [p.tenant, c1],
    );
    expect(delQueRecibio.rows[0].n).toBe(1);
    // El fallido tiene dos: el que falló (queda de historia) y el nuevo, queued.
    const delQueFallo = await admin.query(
      "SELECT delivery_status FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='out' ORDER BY created_at, id",
      [p.tenant, c2],
    );
    expect(delQueFallo.rows.map((r) => r.delivery_status)).toEqual(['failed', 'queued']);
  });
});
