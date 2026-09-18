import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { confirmPayment } from '../application/confirm';

/**
 * El aviso de "pago recibido" que el cliente nunca recibe.
 *
 * `confirmPayment` escribe el mensaje en la conversación y lo marca
 * `delivery_status = 'sent'` — sin encolarlo. En webchat eso está bien: el
 * mensaje sale por el canal en vivo. En WhatsApp no: ahí un saliente tiene
 * que pasar por la cola para que el proveedor lo entregue.
 *
 * La consecuencia no es solo un aviso que falta. Es peor: la bandeja lo
 * muestra como enviado. Si el cliente pregunta "¿me llegó el pago?", el
 * vendedor mira, ve la confirmación en verde y responde que sí le avisó.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const encolados: string[] = [];

async function armarCobro(canal: 'whatsapp' | 'webchat'): Promise<string> {
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1,'Ana',$2,'whatsapp') RETURNING id`,
    [tenant, `+5698888${Math.floor(Math.random() * 9000 + 1000)}`],
  );
  const conv = await admin.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, state)
     VALUES ($1,$2,$3,'open') RETURNING id`,
    [tenant, c.rows[0].id, canal],
  );
  const prov = await admin.query(
    `INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, mode, active)
     VALUES ($1,'simulado','Simulado','CRED_X','test',true) RETURNING id`,
    [tenant],
  );
  const link = await admin.query(
    `INSERT INTO payment_links (tenant_id, provider_id, contact_id, conversation_id,
                                amount_clp, concept, status, expires_at)
     VALUES ($1,$2,$3,$4,15000,'una hora de corte','sent', now() + interval '3 days') RETURNING id`,
    [tenant, prov.rows[0].id, c.rows[0].id, conv.rows[0].id],
  );
  return link.rows[0].id;
}

const confirmar = (linkId: string) =>
  withTenant(admin, tenant, (c: PoolClient) =>
    confirmPayment(
      c,
      { tenantId: tenant, linkId, status: 'paid', amountClp: 15000 },
      { enqueueOutbound: async (job) => void encolados.push(job.messageId) },
    ),
  );

const avisoDe = async (linkId: string) => {
  const r = await admin.query(
    `SELECT m.id, m.delivery_status FROM messages m
       JOIN payment_links l ON l.conversation_id = m.conversation_id
      WHERE l.id = $1 AND m.direction = 'out' AND m.body LIKE '%Pago recibido%'
      ORDER BY m.seq DESC LIMIT 1`,
    [linkId],
  );
  return r.rows[0] as { id: string; delivery_status: string } | undefined;
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('aviso-pago') RETURNING id");
  tenant = t.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

describe('el aviso de pago recibido', () => {
  it('en WhatsApp se ENCOLA: marcarlo enviado sin mandarlo es mentirle a la bandeja', async () => {
    const link = await armarCobro('whatsapp');
    await confirmar(link);

    const aviso = await avisoDe(link);
    expect(aviso, 'no se escribió el aviso').toBeDefined();
    expect(encolados).toContain(aviso!.id);
    // Queda 'queued' hasta que el proveedor confirme: el estado real lo
    // pone el webhook de entrega, no nosotros.
    expect(aviso!.delivery_status).toBe('queued');
  });

  it('en webchat NO se encola: ese canal entrega en vivo', async () => {
    const antes = encolados.length;
    const link = await armarCobro('webchat');
    await confirmar(link);

    const aviso = await avisoDe(link);
    expect(aviso!.delivery_status).toBe('sent');
    expect(encolados.length).toBe(antes);
  });

  it('sin quien encole, el aviso se escribe igual y no se dice enviado', async () => {
    const link = await armarCobro('whatsapp');
    // Así queda si alguien llama a confirmPayment sin conectar la cola: el
    // pago se registra —eso es lo importante— y el aviso queda pendiente,
    // que es la verdad.
    await withTenant(admin, tenant, (c: PoolClient) =>
      confirmPayment(c, { tenantId: tenant, linkId: link, status: 'paid', amountClp: 15000 }),
    );
    const aviso = await avisoDe(link);
    expect(aviso!.delivery_status).toBe('queued');
  });

  it('el pago queda registrado aunque el aviso no salga', async () => {
    const link = await armarCobro('whatsapp');
    await confirmar(link);
    const r = await admin.query('SELECT status FROM payment_links WHERE id = $1', [link]);
    expect(r.rows[0].status).toBe('paid');
  });
});
