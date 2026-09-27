import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addProvider, createPaymentLink } from '../application/links';
import type { CreateLinkInput as PortInput, PaymentProviderPort } from '../domain/providers';

// Qué le pasa el caso de uso al proveedor (#60). Dos datos que no le llegaban:
//
// - el email del PAGADOR: todas las órdenes de todos los tenants salían con
//   'pagos@iaxti.cl', así que el comprobante de Flow le llegaba a IAxTi y
//   ninguna orden del panel de Flow se podía atribuir a nadie;
// - el VENCIMIENTO: vivía solo en payment_links, y sin él la orden del
//   proveedor queda vigente para siempre.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conCorreo: string;
let sinCorreo: string;
const capturadas: PortInput[] = [];

/** Un puerto de mentira: acá solo interesa QUÉ se le pide al proveedor. */
function espia(): PaymentProviderPort {
  return {
    kind: 'simulado',
    webhookAuth: 'firma-en-el-cuerpo',
    async createLink(input) {
      capturadas.push(input);
      return { externalId: `sim-${input.linkId}`, url: `https://pagos-simulados.iaxti.cl/${input.linkId}` };
    },
    verifyWebhook: () => true,
    parseWebhook: () => null,
  };
}

async function nuevoContacto(email: string | null): Promise<string> {
  const r = await withTenant(admin, tenant, (c) =>
    c.query('INSERT INTO contacts (tenant_id, phone, name, email) VALUES ($1,$2,$3,$4) RETURNING id', [
      tenant,
      `+5699${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      'Clienta de prueba',
      email,
    ]),
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  process.env.PAGOS_PLATA_CRED = 'sandbox-cred';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('payments-pagador') RETURNING id");
  tenant = t.rows[0].id;
  conCorreo = await nuevoContacto('clienta@example.invalid');
  sinCorreo = await nuevoContacto(null);
  await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulador',
      credentialRef: 'PAGOS_PLATA_CRED',
      actor: 'test',
    }),
  );
});

afterAll(async () => {
  // El proveedor NO se borra: `payment_links` tiene un trigger BEFORE DELETE
  // que devuelve NEW —null en un DELETE—, así que ninguna fila de links se
  // borra nunca y la FK no deja soltar el proveedor. Queda anotado; arreglar
  // ese trigger no es de este cambio.
  for (const tabla of ['contacts', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
  delete process.env.PAGOS_PLATA_CRED;
});

describe('el cobro sabe a quién le cobra y hasta cuándo (#60)', () => {
  it('el email del pagador es el del contacto, y el vencimiento viaja al proveedor', async () => {
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(
        c,
        {
          tenantId: tenant,
          contactId: conCorreo,
          amountClp: 45_000,
          concept: 'Manicure mensual',
          expiresHours: 48,
          actorUserId: randomUUID(),
        },
        espia,
      ),
    );
    const pedida = capturadas.at(-1)!;
    expect(pedida.payerEmail).toBe('clienta@example.invalid');
    // El mismo vencimiento que guardamos: lo que el proveedor necesita para
    // dejar de aceptar el pago cuando nosotros ya lo damos por vencido.
    expect(pedida.expiresAt.getTime()).toBe(link.expiresAt!.getTime());
    const horas = (pedida.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(47.9);
    expect(horas).toBeLessThanOrEqual(48);
  });

  it('quien escribe el link puede poner el correo a mano', async () => {
    await withTenant(admin, tenant, (c) =>
      createPaymentLink(
        c,
        {
          tenantId: tenant,
          contactId: conCorreo,
          amountClp: 12_000,
          concept: 'Con correo escrito',
          payerEmail: 'otra@example.invalid',
          actorUserId: randomUUID(),
        },
        espia,
      ),
    );
    expect(capturadas.at(-1)!.payerEmail).toBe('otra@example.invalid');
  });

  it('un contacto sin correo cae al último recurso, y ese es el único caso', async () => {
    // Pendiente de decisión del producto: qué correo lleva la orden cuando el
    // pagador no tiene uno (contacto de WhatsApp, o factura al tenant sin
    // contacto). Hoy es un buzón nuestro, y por eso NO debe ser lo normal.
    await withTenant(admin, tenant, (c) =>
      createPaymentLink(
        c,
        {
          tenantId: tenant,
          contactId: sinCorreo,
          amountClp: 9_000,
          concept: 'Sin correo del pagador',
          actorUserId: randomUUID(),
        },
        espia,
      ),
    );
    expect(capturadas.at(-1)!.payerEmail).toBe('pagos@iaxti.cl');
  });
});
