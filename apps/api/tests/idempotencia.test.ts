import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createPipeline, createContact } from '@iaxti/module-crm';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// Idempotency-Key (SPEC §28). Estaba en el OpenAPI y en el CORS desde el
// primer día, y no la leía nadie: el mismo POST reintentado creaba dos
// contactos. Acá se prueba contra la API de verdad.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();

async function crearTrato(llave: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/deals`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(llave ? { 'Idempotency-Key': llave } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-idempotencia') RETURNING id");
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@idem.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));
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
  // `deal_stage_history` antes que `deals`: la historia apunta al trato.
  for (const tabla of [
    'idempotency_keys',
    'deal_stage_history',
    'deals',
    'contacts',
    'user_roles',
    'invitations',
    'outbox',
  ]) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

let n = 0;
async function nuevoContacto(): Promise<string> {
  n += 1;
  const c = await withTenant(admin, tenant, (cl) =>
    createContact(cl, { tenantId: tenant, name: `Cliente ${n}`, phone: `+5691111${String(1000 + n)}` }),
  );
  return c.id;
}

describe('Idempotency-Key (SPEC §28)', () => {
  it('el mismo POST dos veces crea UN trato y devuelve la misma respuesta', async () => {
    const llave = `k-${randomUUID()}`;
    const cuerpo = { contactId: await nuevoContacto(), title: 'Cotización piso flotante', value: 890000 };

    const primera = await crearTrato(llave, cuerpo);
    expect(primera.status).toBeLessThan(300);
    const uno = await primera.json();

    const segunda = await crearTrato(llave, cuerpo);
    expect(segunda.status).toBe(primera.status);
    expect(segunda.headers.get('Idempotent-Replay')).toBe('true');
    const dos = await segunda.json();
    // MISMO id: no es otro trato parecido, es la misma respuesta.
    expect(dos.id).toBe(uno.id);

    const cuantos = await admin.query(
      'SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1 AND title = $2',
      [tenant, cuerpo.title],
    );
    expect(cuantos.rows[0].n).toBe(1);
  });

  /**
   * La respuesta está guardada ANTES de que el cliente la reciba (#778).
   *
   * Lo que esto arregla: el interceptor guardaba con `void` dentro de un `tap`,
   * así que el 201 salía antes de que `completed_at` quedara escrito. En esa
   * ventana `reservarLlave` devuelve `en_curso` y el interceptor contesta
   * **409** — o sea que el reintento rápido, el caso para el que existe esta
   * cabecera, era justo el que fallaba.
   *
   * ## Por qué se afirma el ORDEN y no un reintento rápido
   *
   * Un reintento «lo más rápido posible» es una moneda al aire: local la base
   * está a 1 ms y la escritura gana; en CI, con cuatro archivos en paralelo,
   * pierde. Una prueba así pasa o falla según la máquina, que es el defecto que
   * esta noche se estuvo sacando del repositorio.
   *
   * Lo que sí es determinista es la garantía: cuando la respuesta llegó, la
   * fila ya está completa. Si eso se cumple, NINGÚN reintento —rápido o lento—
   * puede ver `en_curso`.
   */
  it('cuando la respuesta llega, la llave YA está completa', async () => {
    const llave = `k-${randomUUID()}`;
    const cuerpo = { contactId: await nuevoContacto(), title: 'Orden antes de responder', value: 1 };

    const primera = await crearTrato(llave, cuerpo);
    expect(primera.status).toBeLessThan(300);

    // Sin ninguna espera entremedio: justo después de recibir la respuesta.
    const fila = await admin.query(
      'SELECT completed_at, response_status FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
      [tenant, llave],
    );
    expect(
      fila.rows[0]?.completed_at,
      'la respuesta salió antes de guardarse: un reintento inmediato recibiría 409',
    ).not.toBeNull();
    expect(fila.rows[0]?.response_status).toBe(primera.status);
  });

  it('el reintento inmediato recibe la respuesta guardada, no un 409', async () => {
    // Con la garantía de arriba, esto no puede fallar por timing. Se queda
    // porque es lo que la cabecera PROMETE, y una garantía sin la promesa
    // escrita se pierde en el próximo refactor.
    const llave = `k-${randomUUID()}`;
    const cuerpo = { contactId: await nuevoContacto(), title: 'Reintento inmediato', value: 2 };

    const primera = await crearTrato(llave, cuerpo);
    const segunda = await crearTrato(llave, cuerpo);
    expect(segunda.status, 'un 409 acá es el defecto de #778').toBe(primera.status);
    expect(segunda.headers.get('Idempotent-Replay')).toBe('true');
  });

  it('sin la cabecera el pedido SE EJECUTA de nuevo: lo frena el dominio, no la llave', async () => {
    const contactoPropio = await nuevoContacto();
    const cuerpo = { contactId: contactoPropio, title: 'Sin llave' };
    const primera = await crearTrato(null, cuerpo);
    expect(primera.status).toBeLessThan(300);

    const segunda = await crearTrato(null, cuerpo);
    expect(segunda.headers.get('Idempotent-Replay')).toBeNull();
    // La regla del CRM lo rechaza porque el pedido corrió DE VERDAD: una
    // oportunidad abierta por contacto y pipeline.
    expect(segunda.status).toBe(400);
    expect((await segunda.json()).code).toBe('DEAL_INVALID');
  });

  it('la misma llave con OTRO cuerpo es un error del cliente, no un reintento', async () => {
    const llave = `k-${randomUUID()}`;
    const primera = await crearTrato(llave, { contactId: await nuevoContacto(), title: 'Primera' });
    expect(primera.status).toBeLessThan(300);
    const distinta = await crearTrato(llave, { contactId: await nuevoContacto(), title: 'Otra muy distinta' });
    expect(distinta.status).toBe(422);
    expect((await distinta.json()).code).toBe('IDEMPOTENCY_LLAVE_REUSADA');
  });

  it('un pedido que falla SUELTA la llave: se puede reintentar con la misma', async () => {
    const llave = `k-${randomUUID()}`;
    // Sin título: 400 del dominio.
    const malo = await crearTrato(llave, { contactId: await nuevoContacto(), title: '  ' });
    expect(malo.status).toBe(400);
    const guardada = await admin.query('SELECT 1 FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [tenant, llave]);
    expect(guardada.rowCount).toBe(0);
    // La misma llave, ahora bien: sale adelante en vez de quedar condenada.
    const bueno = await crearTrato(llave, { contactId: await nuevoContacto(), title: 'Ahora sí' });
    expect(bueno.status).toBeLessThan(300);
  });

  it('la llave es de ESTE tenant y de nadie más', async () => {
    const llave = `k-${randomUUID()}`;
    await crearTrato(llave, { contactId: await nuevoContacto(), title: 'Propia' });
    const fila = await admin.query('SELECT tenant_id FROM idempotency_keys WHERE key = $1', [llave]);
    expect(fila.rows).toHaveLength(1);
    expect(fila.rows[0].tenant_id).toBe(tenant);
  });
});
