import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { addProvider } from '@iaxti/module-payments';
import { processPaymentWebhook, type PaymentWebhookJob } from '../src/payments';

// Flow avisa UNA sola vez y no hay nadie que reconcilie después. Por eso un
// job que TERMINA BIEN sin saber en qué quedó el pago es un pago perdido para
// siempre: el cliente pagó, el comercio tiene la plata y en IAxTi no queda
// nada. Antes, cualquier tropiezo de la consulta de estado —Flow caído, la
// variable de credenciales todavía sin poner— devolvía 'flow_sin_estado' y el
// job se marcaba completo. Ahora eso LANZA, y la cola reintenta.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const CRED = 'synthetic-key-608:synthetic-secret-608';

let admin: Pool;
let tenant: string;
let proveedor: string;

async function nuevoLink(): Promise<string> {
  const r = await withTenant(admin, tenant, (c) =>
    c.query(
      `INSERT INTO payment_links (tenant_id, provider_id, contact_id, amount_clp, concept, expires_at, status)
       VALUES ($1,$2,NULL,$3,$4, now() + interval '72 hours', 'sent') RETURNING id`,
      [tenant, proveedor, 45_000, 'Manicure mensual'],
    ),
  );
  return r.rows[0].id as string;
}

function job(token: string): PaymentWebhookJob {
  return {
    moduleId: 'payments',
    tenantId: tenant,
    providerId: proveedor,
    providerKind: 'flow',
    // Lo que trae el webhook de Flow: el token y nada más.
    pago: {
      linkId: '',
      status: 'pending',
      method: null,
      providerPaymentId: token,
      receiptUrl: null,
      amountClp: null,
    },
  };
}

beforeAll(async () => {
  process.env.FLOW_PLATA_CRED = CRED;
  process.env.FLOW_API_BASE = 'https://sandbox.flow.cl/api';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('workers-flow-plata') RETURNING id");
  tenant = t.rows[0].id;
  const p = await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'flow',
      name: 'Flow sandbox',
      credentialRef: 'FLOW_PLATA_CRED',
      actor: 'test',
    }),
  );
  proveedor = p.id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM payment_links WHERE tenant_id = $1 AND status <> 'paid'`, [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
  delete process.env.FLOW_PLATA_CRED;
});

describe('la confirmación de Flow no se puede perder (#61)', () => {
  it('si Flow se cae al consultar el estado, el job falla para que se reintente', async () => {
    await nuevoLink();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('mantención', { status: 503 }));
    await expect(processPaymentWebhook(admin, job('tok-503'), fetcher)).rejects.toThrow(/reintentar/);
  });

  it('sin la variable de credenciales tampoco se da por terminado (y se nombra la variable)', async () => {
    await nuevoLink();
    delete process.env.FLOW_PLATA_CRED;
    const fetcher = vi.fn<typeof fetch>();
    try {
      await expect(processPaymentWebhook(admin, job('tok-sin-cred'), fetcher)).rejects.toThrow(
        /FLOW_PLATA_CRED/,
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      process.env.FLOW_PLATA_CRED = CRED;
    }
  });

  it('un pago que Flow dice pendiente no registra nada (y ahí sigue el hueco)', async () => {
    // Flow contestó, así que el job termina: no hay nada que reintentar con la
    // misma pregunta. Pero Flow no vuelve a avisar, así que este link queda
    // pendiente y nadie lo mira otra vez: eso lo tiene que cerrar un barrido de
    // reconciliación de links pendientes, que hoy NO existe.
    const link = await nuevoLink();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ commerceOrder: link, status: 1 }));
    expect(await processPaymentWebhook(admin, job('tok-pendiente'), fetcher)).toEqual({
      outcome: 'pendiente',
    });
    const pagos = await admin.query('SELECT count(*)::int AS n FROM payments WHERE link_id = $1', [link]);
    expect(pagos.rows[0].n).toBe(0);
  });

  it('un token que Flow no reconoce SÍ se da por terminado: no hay nada que reintentar', async () => {
    // Flow contesta BIEN y no trae orden. Es el único camino definitivo que
    // queda, y es el que de verdad significa «ese token no es una orden mía».
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 200 }));
    const res = await processPaymentWebhook(admin, job('tok-inventado'), fetcher);
    expect(res.outcome).toBe('flow_token_desconocido');
  });

  // Esta es la prueba que faltaba, y la que separa los dos casos que la versión
  // anterior confundía. Comprobado contra el proveedor de verdad:
  //
  //     GET https://sandbox.flow.cl/api/payment/getStatus  (apiKey inválida)
  //     → HTTP 400 {"code":109,"message":"Invalid ApiKey"}
  //
  // Decidir por el status HTTP —«4xx es que Flow no conoce este token»— hace
  // que un secreto rotado en el panel de Flow, o credenciales de prueba pegadas
  // en la fila `live`, terminen el job BIEN. El cliente pagó, el comercio tiene
  // la plata, y en IAxTi no queda nada. `flow-config.ts` valida la FORMA de las
  // credenciales, no que sirvan, así que nada antes de acá lo agarra.
  it('una credencial que Flow rechaza LANZA: 400 con código no es "no conozco este token"', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 109, message: 'Invalid ApiKey' }, { status: 400 }));
    await expect(processPaymentWebhook(admin, job('tok-cred-mala'), fetcher)).rejects.toThrow(
      /109/,
    );
  });

  it('un cuerpo que no se puede leer tampoco termina el job', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 400 }));
    await expect(processPaymentWebhook(admin, job('tok-ilegible'), fetcher)).rejects.toThrow(
      /reintentar/,
    );
  });

  it('el pago confirmado por getStatus queda registrado con su monto y su medio', async () => {
    const link = await nuevoLink();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        commerceOrder: link,
        status: 2,
        flowOrder: 608,
        paymentData: { media: 'webpay', amount: 45_000 },
      }),
    );
    const res = await processPaymentWebhook(admin, job('tok-pagado'), fetcher);
    expect(res.outcome).toBe('paid');
    const pago = await admin.query('SELECT * FROM payments WHERE tenant_id = $1 AND link_id = $2', [
      tenant,
      link,
    ]);
    expect(Number(pago.rows[0].amount_clp)).toBe(45_000);
    expect(pago.rows[0].method).toBe('webpay');
    expect(pago.rows[0].provider_payment_id).toBe('608');
    // Y la consulta va firmada al destino oficial del modo del proveedor.
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain('https://sandbox.flow.cl/api/payment/getStatus');
    expect(url).toMatch(/[?&]s=[a-f0-9]{64}/);
  });
});
