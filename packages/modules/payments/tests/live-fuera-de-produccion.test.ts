import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createPaymentLink, listLinks } from '../application/links';

/**
 * El modo live fuera de producción, por la puerta de atrás.
 *
 * La regla —«live cobra dinero real, solo en producción»— se verificaba al
 * dar de alta el proveedor. Eso asume que la única forma de que exista una
 * fila `mode = 'live'` es haberla creado en este mismo ambiente, y no es
 * cierto: basta restaurar un respaldo de producción en staging, que es algo
 * que se hace, para tener filas live donde no corresponde.
 *
 * Comprobado antes de arreglarlo: con una fila live heredada,
 * `createPaymentLink` creaba el cobro desde staging sin que nada lo mirara.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
let heredado: string;
let deTest: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('live-heredado') RETURNING id");
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1,'Ana','+56977770001','whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;

  // Así queda staging tras restaurar un respaldo de producción: la fila ya
  // existe, nadie la creó acá, y su modo dice 'live'.
  const p = await admin.query(
    `INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, mode, active)
     VALUES ($1,'simulado','Heredado de producción','CRED_HEREDADA','live',true) RETURNING id`,
    [tenant],
  );
  heredado = p.rows[0].id;
  const q = await admin.query(
    `INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, mode, active)
     VALUES ($1,'simulado','El de este ambiente','CRED_TEST','test',true) RETURNING id`,
    [tenant],
  );
  deTest = q.rows[0].id;

  process.env.CRED_HEREDADA = 'k_live_loquesea';
  process.env.CRED_TEST = 'k_test_loquesea';
});

afterAll(async () => {
  delete process.env.CRED_HEREDADA;
  delete process.env.CRED_TEST;
  delete process.env.IAXTI_ENV;
  await admin.end();
});

const cobrar = (providerId: string) =>
  withTenant(admin, tenant, (c) =>
    createPaymentLink(c, {
      tenantId: tenant,
      contactId: contacto,
      providerId,
      amountClp: 15000,
      concept: 'una hora de corte',
    }),
  );

describe('cobrar con un proveedor live', () => {
  it('en staging no se puede, aunque la fila ya exista', async () => {
    process.env.IAXTI_ENV = 'staging';
    await expect(cobrar(heredado)).rejects.toThrow(/cobra dinero real/);
  });

  it('tampoco en desarrollo, ni sin IAXTI_ENV definida', async () => {
    process.env.IAXTI_ENV = 'development';
    await expect(cobrar(heredado)).rejects.toThrow(/cobra dinero real/);
    // Sin la variable, el ambiente es desconocido. Un ambiente desconocido
    // NO es producción: la duda se resuelve del lado de no cobrar.
    delete process.env.IAXTI_ENV;
    await expect(cobrar(heredado)).rejects.toThrow(/cobra dinero real/);
  });

  it('el proveedor de test del mismo tenant sigue funcionando', async () => {
    process.env.IAXTI_ENV = 'staging';
    const link = await cobrar(deTest);
    expect(link.id).toBeTruthy();
    // Que el cobro en live se caiga no puede dejar sin cobrar a nadie más.
    expect(link.providerId).toBe(deTest);
  });

  it('en producción sí cobra: la regla es el ambiente, no el proveedor', async () => {
    process.env.IAXTI_ENV = 'production';
    const link = await cobrar(heredado);
    expect(link.id).toBeTruthy();
  });

  it('el intento rechazado no deja un cobro a medias en la base', async () => {
    process.env.IAXTI_ENV = 'staging';
    const antes = (await withTenant(admin, tenant, (c) => listLinks(c, tenant))).length;
    await expect(cobrar(heredado)).rejects.toThrow();
    const despues = (await withTenant(admin, tenant, (c) => listLinks(c, tenant))).length;
    // La guarda va ANTES del INSERT: si fuera después, quedaría una fila
    // de cobro sin url que nadie sabría interpretar.
    expect(despues).toBe(antes);
  });
});
