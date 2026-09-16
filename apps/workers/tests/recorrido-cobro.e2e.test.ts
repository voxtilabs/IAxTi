import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound, sendMessage } from '@iaxti/module-conversations';
import { createPipeline, createDeal } from '@iaxti/module-crm';
import {
  addProvider,
  cancelLink,
  confirmPayment,
  createPaymentLink,
  expireLinks,
  listLinks,
} from '@iaxti/module-payments';

/**
 * El otro recorrido que promete el producto: cobrar desde el chat.
 *
 * "Cobra con links de pago desde el chat" es la cuarta promesa, y el link es
 * el cierre de la venta. Acá se camina entero con las piezas reales — la
 * cotización, el link, el pago, y lo que pasa con la oportunidad — para ver
 * si encajan entre sí.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;
let conversacion: string;
let trato: string;
const duena = randomUUID();
const vendedora = randomUUID();

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

beforeAll(async () => {
  process.env.PAGOS_RECORRIDO_CRED = 'sandbox';
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name, plan) VALUES ('recorrido-cobro', 'crece') RETURNING id",
  );
  tenant = t.rows[0].id;

  const res = await en((c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56955553434',
      channel: 'whatsapp',
      body: 'Quiero las dos sillas que vi en la historia',
    }),
  );
  contacto = res.contact.id;
  conversacion = res.conversation.id;

  const pipe = await en((c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Cotizado', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );
  const d = await en((c) =>
    createDeal(c, {
      tenantId: tenant,
      contactId: contacto,
      pipelineId: pipe.pipeline.id,
      title: 'Dos sillas Eames',
      value: 120000,
    }),
  );
  trato = d.id;

  await en((c) =>
    addProvider(c, {
      tenantId: tenant,
      kind: 'simulado',
      name: 'Simulador',
      credentialRef: 'PAGOS_RECORRIDO_CRED',
      actor: duena,
    }),
  );
});

afterAll(async () => {
  await admin.end();
});

describe('cobrar desde el chat, de punta a punta', () => {
  let link: string;

  it('1. el monto sale de la oportunidad: no hay que escribirlo dos veces', async () => {
    const l = await en((c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        conversationId: conversacion,
        dealId: trato,
        concept: 'Dos sillas Eames',
        actor: vendedora,
      }),
    );
    link = l.id;
    expect(l.amountClp).toBe(120000);
    expect(l.status).toBe('created');
    expect(l.url).toBeTruthy();
  });

  it('2. el tope de quien cobra se respeta: no es lo mismo el dueño que el vendedor', async () => {
    await expect(
      en((c) =>
        createPaymentLink(c, {
          tenantId: tenant,
          contactId: contacto,
          conversationId: conversacion,
          concept: 'Juego de comedor',
          amountClp: 800000,
          maxAmountClp: 100000,
          actor: vendedora,
        }),
      ),
    ).rejects.toThrow(/supera tu tope/);
  });

  it('3. el link viaja al chat como un mensaje más', async () => {
    const l = (await en((c) => listLinks(c, tenant, {}))).find((x) => x.id === link)!;
    await en((c) =>
      sendMessage(c, {
        tenantId: tenant,
        conversationId: conversacion,
        authorKind: 'user',
        authorId: vendedora,
        body: `Listo: acá puedes pagar las dos sillas → ${l.url}`,
      }),
    );
    const msg = await admin.query(
      `SELECT body FROM messages WHERE tenant_id = $1 AND direction = 'out' ORDER BY seq DESC LIMIT 1`,
      [tenant],
    );
    expect(msg.rows[0].body).toContain(l.url);
  });

  it('4. el pago se confirma una vez, y confirmarlo de nuevo no cobra dos veces', async () => {
    const primera = await en((c) =>
      confirmPayment(c, {
        tenantId: tenant,
        linkId: link,
        status: 'paid',
        externalId: 'sim-0001',
        amountClp: 120000,
      }),
    );
    expect(primera.outcome).toBe('paid');

    // El webhook del proveedor llega dos veces: es lo normal, no una falla.
    const segunda = await en((c) =>
      confirmPayment(c, {
        tenantId: tenant,
        linkId: link,
        status: 'paid',
        externalId: 'sim-0001',
        amountClp: 120000,
      }),
    );
    expect(segunda.outcome).toBe('already');

    const pagos = await admin.query(
      'SELECT count(*)::int n FROM payments WHERE tenant_id = $1 AND link_id = $2',
      [tenant, link],
    );
    expect(pagos.rows[0].n).toBe(1);
  });

  it('5. un link pagado es inmutable: ni se cancela, ni lo vence el barrido', async () => {
    await expect(
      en((c) => cancelLink(c, { tenantId: tenant, linkId: link, actor: duena })),
    ).rejects.toThrow(/ya no se puede cancelar/);

    // La base lo defiende ella misma: un UPDATE directo sobre un link pagado
    // tampoco pasa. Se comprueba acá porque una garantía que vive solo en el
    // código se pierde el día que alguien escriba SQL a mano.
    await expect(
      admin.query("UPDATE payment_links SET expires_at = now() - interval '1 day' WHERE id = $1", [
        link,
      ]),
    ).rejects.toThrow(/inmutable/);

    // Y el barrido de vencidos no lo toca: se vence otro link, no este.
    const otro = await en((c) =>
      createPaymentLink(c, {
        tenantId: tenant,
        contactId: contacto,
        conversationId: conversacion,
        concept: 'Mesa de centro',
        amountClp: 45000,
        actor: vendedora,
      }),
    );
    await admin.query("UPDATE payment_links SET expires_at = now() - interval '1 day' WHERE id = $1", [
      otro.id,
    ]);
    await en((c) => expireLinks(c, tenant));

    const links = await en((c) => listLinks(c, tenant, {}));
    expect(links.find((x) => x.id === link)!.status).toBe('paid');
    expect(links.find((x) => x.id === otro.id)!.status).toBe('expired');
  });

  it('6. el pago avisa, para que la oportunidad y la bandeja se enteren', async () => {
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id = $1 AND name = 'payment.received' ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(evento.rowCount).toBe(1);
    expect(evento.rows[0].payload.conversationId).toBe(conversacion);
  });
});
