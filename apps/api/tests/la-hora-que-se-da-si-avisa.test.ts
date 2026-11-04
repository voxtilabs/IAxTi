import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { runMigrations, withTenant } from '@iaxti/db';
import { citasPorRecordar } from '@iaxti/module-calendar';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * La hora que da el negocio SÍ recibe recordatorio (#1249).
 *
 * Medido antes de arreglarlo, los tres eslabones de la cadena:
 * `dar-una-hora.tsx:86` posteaba `{contactId, inicio, fin}` —sin `confirmada`
 * y sin `conversationId`—, `agenda.ts:360` la guardaba como `proposed`, y
 * `recordatorios.ts:55` solo barre `confirmed|reminded`. Resultado: ninguna
 * cita creada desde la interfaz entraba jamás al barrido, en un módulo que
 * existe para bajar el no-show.
 *
 * Esta prueba entra por el MISMO endpoint que la pantalla y después le
 * pregunta al barrido de verdad si la ve. Comprobar que la fila quedó
 * `confirmed` habría sido comprobar la mitad: lo que importa es que el
 * recordatorio la alcance.
 */
const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let pool: Pool;
let app: INestApplication;
let base: string;
let tenant: string;
let contacto: string;
let firmar: (userId: string) => Promise<string>;
const duena = randomUUID();

beforeAll(async () => {
  pool = new Pool({ connectionString: url });
  await runMigrations(pool);
  usarPool(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES('la hora que se da') RETURNING id")).rows[0].id;
  await pool.query(
    'INSERT INTO user_roles(tenant_id,user_id,role_id) SELECT $1,$2,id FROM roles WHERE name=$3 AND tenant_id IS NULL',
    [tenant, duena, 'ADMIN'],
  );
  contacto = (
    await pool.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin)
       VALUES ($1, 'Clienta del teléfono', $2, 'whatsapp') RETURNING id`,
      [tenant, `+569${String(Date.now()).slice(-8)}`],
    )
  ).rows[0].id;
  const keys = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), alg: 'ES256' }] });
  firmar = (id) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(id)
      .setIssuer('https://identity.example.test')
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  app = await createApp({
    jwtVerify: async (token) => ({
      userId: (await jwtVerify(token, jwks, { issuer: 'https://identity.example.test' })).payload.sub!,
    }),
    resolveRole: dbRoleResolver(pool),
    resolveAccesoModulo: null,
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  usarPool(null);
  await pool?.end();
});

/** El mismo cuerpo que manda la pantalla «Dar una hora»: tres campos y nada más. */
async function darUnaHora(inicio: string, fin: string, extra: Record<string, unknown> = {}) {
  return fetch(`${base}/v1/agenda`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ contactId: contacto, inicio, fin, ...extra }),
  });
}

describe('la hora que da el negocio sí recibe recordatorio (#1249)', () => {
  it('nace confirmada, con conversación, y el barrido la ve', async () => {
    // Dentro de la ventana de 24 h del barrido, que es donde se juega.
    const inicio = new Date(Date.now() + 23.5 * 3600_000).toISOString();
    const fin = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await darUnaHora(inicio, fin);
    expect(res.status).toBe(201);
    const cita = (await res.json()) as { id: string; status: string };
    expect(cita.status).toBe('confirmed');

    const fila = await pool.query('SELECT conversation_id FROM appointments WHERE id = $1', [cita.id]);
    expect(fila.rows[0].conversation_id).not.toBeNull();

    // Lo que de verdad se prueba: que el barrido la alcance. Sin esto, la
    // prueba diría «la fila quedó bien» sobre una cita que igual nunca
    // recibe nada, que es el defecto exacto que esto arregla.
    const porRecordar = await withTenant(pool, tenant, (c) => citasPorRecordar(c, { tenantId: tenant, ahora: new Date() }));
    expect(porRecordar.map((c) => c.appointmentId)).toContain(cita.id);
  });

  /**
   * El defecto cambia; la posibilidad no se pierde. Quien quiera una hora
   * que todavía nadie aceptó la pide explícitamente, y esa NO entra al
   * barrido — `proposed` sigue significando lo que significaba.
   */
  it('con confirmada:false sigue siendo una propuesta y no se avisa', async () => {
    // Otro hueco, sin solaparse con la cita del caso anterior: el módulo rechaza
    // el choque con 400 y con razón.
    const inicio = new Date(Date.now() + 23.2 * 3600_000).toISOString();
    const fin = new Date(Date.now() + 23.4 * 3600_000).toISOString();
    const res = await darUnaHora(inicio, fin, { confirmada: false });
    expect(res.status).toBe(201);
    const cita = (await res.json()) as { id: string; status: string };
    expect(cita.status).toBe('proposed');
    const porRecordar = await withTenant(pool, tenant, (c) => citasPorRecordar(c, { tenantId: tenant, ahora: new Date() }));
    expect(porRecordar.map((c) => c.appointmentId)).not.toContain(cita.id);
  });
});
