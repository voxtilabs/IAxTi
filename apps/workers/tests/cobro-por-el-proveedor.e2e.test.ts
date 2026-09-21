import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import {
  addProvider,
  createPaymentLink,
  getProviderById,
  listLinks,
  paymentProviderFor,
} from '@iaxti/module-payments';
import { processPaymentWebhook } from '../src/payments';

/**
 * El cobro POR EL PROVEEDOR, de punta a punta (#60).
 *
 * Ya había un recorrido de cobro, pero llamaba a `confirmPayment` directo:
 * saltaba el proveedor y saltaba el webhook. O sea, probaba nuestra lógica
 * y no el camino por el que de verdad llega un pago.
 *
 * Este camina lo que falta, con el proveedor `simulado` —que recorre lo
 * mismo que Flow y no necesita ninguna cuenta externa—:
 *
 *   1. El proveedor se da de alta con la credencial POR REFERENCIA.
 *   2. El link se crea llamando al puerto del proveedor de verdad.
 *   3. El proveedor "avisa" con un webhook FIRMADO con HMAC.
 *   4. La firma se verifica, el tenant se resuelve desde el id del
 *      proveedor (que es lo único que trae la URL) y el pago se confirma.
 *   5. El aviso al cliente queda encolado, no declarado enviado.
 *
 * El paso 4 es el que se rompía con el rol de producción hasta #302.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
let conversacion: string;
let proveedor: string;

const CRED = 'CRED_SIMULADO_E2E';
const SECRETO = 'SECRETO_WEBHOOK_E2E';

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('cobro-e2e') RETURNING id");
  tenant = t.rows[0].id;

  process.env[CRED] = 'llave-de-mentira';
  process.env[SECRETO] = 'secreto-de-mentira';
  process.env.IAXTI_ENV = 'test';

  // Una conversación real: el link se manda por el chat.
  const entrada = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56977778888',
      body: '¿Cuánto sale el corte y color?',
      channel: 'webchat',
    }),
  );
  contacto = entrada.contact.id;
  conversacion = entrada.conversation.id;

  const p = await withTenant(admin, tenant, (c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulado',
      credentialRef: CRED,
      webhookSecretRef: SECRETO,
      mode: 'test',
      actor: 'u-1',
    }),
  );
  proveedor = p.id;
});

afterAll(async () => {
  delete process.env[CRED];
  delete process.env[SECRETO];
  delete process.env.IAXTI_ENV;
  await admin.end();
});

describe('cobrar de punta a punta con un proveedor', () => {
  let linkId: string;

  it('la credencial va por REFERENCIA: en la base está el nombre, no el valor', async () => {
    const p = await withTenant(admin, tenant, (c) => getProviderById(c, tenant, proveedor));
    expect(p.credentialRef).toBe(CRED);
    // Lo que importa: el valor NO está guardado en ninguna parte.
    const fila = await admin.query('SELECT * FROM payment_providers WHERE id = $1', [proveedor]);
    expect(JSON.stringify(fila.rows[0])).not.toContain('llave-de-mentira');
  });

  it('el link se crea LLAMANDO al proveedor, no inventando la url', async () => {
    const link = await withTenant(admin, tenant, (c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        conversationId: conversacion,
        providerId: proveedor,
        amountClp: 45000,
        concept: 'Corte y color',
        actorUserId: randomUUID(),
      }),
    );
    linkId = link.id;
    // El proveedor simulado devuelve `sim-<id>` y su url: si el puerto no se
    // hubiera llamado, esto vendría vacío.
    // El id del proveedor no se expone en el objeto pero sí se guarda: si
    // el puerto no se hubiera llamado, la columna vendría vacía.
    const fila = await admin.query('SELECT external_id FROM payment_links WHERE id = $1', [link.id]);
    expect(fila.rows[0].external_id).toBe(`sim-${link.id}`);
    expect(link.url).toContain(link.id);
    expect(link.status).toBe('created');
  });

  it('un webhook SIN firma no se acepta', () => {
    const port = paymentProviderFor('simulado');
    const cuerpo = JSON.stringify({ linkId, status: 'paid' });
    expect(port.verifyWebhook(cuerpo, {}, 'secreto-de-mentira')).toBe(false);
    expect(port.verifyWebhook(cuerpo, { 'x-iaxti-pay-signature': 'cualquiera' }, 'secreto-de-mentira')).toBe(
      false,
    );
  });

  it('con la firma buena, el pago se confirma y el link queda pagado', async () => {
    const cuerpo = JSON.stringify({
      linkId,
      status: 'paid',
      method: 'tarjeta',
      providerPaymentId: 'sim-pago-1',
      amountClp: 45000,
    });
    const firma = createHmac('sha256', 'secreto-de-mentira').update(cuerpo).digest('hex');

    const port = paymentProviderFor('simulado');
    expect(port.verifyWebhook(cuerpo, { 'x-iaxti-pay-signature': firma }, 'secreto-de-mentira')).toBe(true);
    const pago = port.parseWebhook(cuerpo)!;
    expect(pago.linkId).toBe(linkId);

    const res = await processPaymentWebhook(
      admin,
      {
        moduleId: 'payments',
        tenantId: tenant,
        providerId: proveedor,
        providerKind: 'simulado',
        pago,
        requestId: randomUUID(),
      },
      fetch,
    );
    expect(res.outcome).toBe('paid');

    const links = await withTenant(admin, tenant, (c) => listLinks(c, tenant));
    const pagado = links.find((l) => l.id === linkId)!;
    expect(pagado.status).toBe('paid');
    expect(pagado.paidAt).not.toBeNull();
  });

  it('el aviso al cliente queda ENCOLADO, no declarado enviado', async () => {
    const m = await admin.query(
      `SELECT id, delivery_status FROM messages
        WHERE tenant_id = $1 AND conversation_id = $2 AND body LIKE '%Pago recibido%'`,
      [tenant, conversacion],
    );
    expect(m.rowCount).toBe(1);
    // webchat entrega en vivo, así que este NO va por la cola: se marca
    // enviado y punto. En WhatsApp sí se encolaría (#277).
    expect(m.rows[0].delivery_status).toBe('sent');
    expect((await admin.query("SELECT id FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenant])).rowCount).toBe(0);
  });

  it('el mismo webhook dos veces no cobra dos veces', async () => {
    const pago = paymentProviderFor('simulado').parseWebhook(
      JSON.stringify({ linkId, status: 'paid', providerPaymentId: 'sim-pago-1', amountClp: 45000 }),
    )!;
    const res = await processPaymentWebhook(
      admin,
      { moduleId: 'payments', tenantId: tenant, providerId: proveedor, providerKind: 'simulado', pago },
      fetch,
      {},
    );
    // Idempotente: el proveedor reintenta y no puede duplicar el cobro.
    expect(res.outcome).toBe('already');

    const m = await admin.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND body LIKE '%Pago recibido%'`,
      [tenant],
    );
    expect(m.rows[0].n).toBe(1);
  });

  it('un link pagado no se puede cancelar: es inmutable', async () => {
    const { cancelLink } = await import('@iaxti/module-payments');
    await expect(
      withTenant(admin, tenant, (c) => cancelLink(c, { tenantId: tenant, linkId })),
    ).rejects.toThrow();
  });
});
