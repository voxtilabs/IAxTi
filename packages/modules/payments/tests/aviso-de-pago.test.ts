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
const pedidos = async () => (await admin.query("SELECT payload FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'", [tenant])).rows.map(r => r.payload);

// Contador y no azar (#1025): con Math.random() sobre 9.000 valores y seis
// cobros por corrida, el teléfono colisionaba cada ~500 corridas de CI y el
// unique de contacts pintaba rojo un PR ajeno. Sigue en el rango 99, que no
// se asigna a personas en Chile.
let siguienteTelefono = 1000;

async function armarCobro(canal: 'whatsapp' | 'webchat'): Promise<string> {
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin)
     VALUES ($1,'Ana',$2,'whatsapp') RETURNING id`,
    [tenant, `+5698888${siguienteTelefono++}`],
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

/**
 * La tabla a la que se desvía el INSERT del pedido durable. Tiene que NO
 * existir: así el error lo pone Postgres —`relation "…" does not exist`— y la
 * transacción queda abortada de verdad, que es la mitad de lo que esta prueba
 * mira.
 */
const OUTBOX_INEXISTENTE = 'outbox_que_no_existe';

/**
 * Un cliente al que se le cae la escritura en el outbox (#910).
 *
 * Antes la falla se provocaba creando un trigger `BEFORE INSERT ON outbox` en
 * el esquema COMPARTIDO y borrándolo en un `finally`. El filtro por tenant
 * acotaba el daño, pero si el proceso muere en el medio —un Ctrl-C, un OOM, el
 * timeout de la suite— el trigger y su función se quedan en la base para
 * siempre, apuntando a un tenant que ya no existe. Nada falla y nadie se
 * entera, que es la peor forma de dejar basura.
 *
 * El desvío va en el TEXTO de la consulta de esta conexión, como en #913: el
 * catálogo no se toca y para los demás archivos que corren en paralelo el
 * outbox nunca dejó de existir.
 *
 * Y el error sigue viniendo de Postgres, no de un `throw` del arnés: lo que
 * esta prueba fija es que la transacción entera se revierte —el pago no queda
 * registrado— y eso solo pasa de verdad si la transacción se aborta.
 */
function clienteSinOutbox(cliente: PoolClient): PoolClient {
  const consultar = cliente.query.bind(cliente) as unknown as (...args: unknown[]) => unknown;
  // El `\b` del final deja fuera el nombre ya desviado: `_` es carácter de
  // palabra, así que `outbox_que_no_existe` no vuelve a calzar.
  const desviar = (sql: string) => sql.replace(/\boutbox\b/g, OUTBOX_INEXISTENTE);
  /**
   * Solo el PEDIDO DURABLE, como el trigger que reemplaza.
   *
   * `confirmPayment` publica dos eventos en la misma transacción, y el nombre
   * no está en el texto de la consulta sino en sus parámetros —`publishEvent`
   * usa el mismo INSERT para todos—. Desviar cualquier escritura al outbox
   * haría fallar la primera que pase, y esta prueba dejaría de hablar del
   * pedido de entrega para hablar de «algo del outbox».
   */
  const esElPedido = (valores: unknown) =>
    Array.isArray(valores) && valores.includes('message.delivery_requested');
  return new Proxy(cliente, {
    get(destino, prop, receptor) {
      if (prop !== 'query') return Reflect.get(destino, prop, receptor);
      return (...args: unknown[]) => {
        const [texto, ...resto] = args;
        if (typeof texto === 'string') {
          return esElPedido(resto[0]) ? consultar(desviar(texto), ...resto) : consultar(...args);
        }
        const config = texto as { text?: unknown; values?: unknown } | null;
        if (config && typeof config.text === 'string' && esElPedido(config.values)) {
          return consultar({ ...config, text: desviar(config.text) }, ...resto);
        }
        return consultar(...args);
      };
    },
  });
}

const confirmar = (linkId: string) =>
  withTenant(admin, tenant, (c: PoolClient) =>
    confirmPayment(
      c,
      { tenantId: tenant, linkId, status: 'paid', amountClp: 15000 },
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
  await admin.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id=$1', [tenant]);
  await admin.end();
});

describe('el aviso de pago recibido', () => {
  it('en WhatsApp se ENCOLA: marcarlo enviado sin mandarlo es mentirle a la bandeja', async () => {
    const link = await armarCobro('whatsapp');
    await confirmar(link);

    const aviso = await avisoDe(link);
    expect(aviso, 'no se escribió el aviso').toBeDefined();
    expect(await pedidos()).toContainEqual({ messageId: aviso!.id, policy: 'transactional' });
    // Queda 'queued' hasta que el proveedor confirme: el estado real lo
    // pone el webhook de entrega, no nosotros.
    expect(aviso!.delivery_status).toBe('queued');
  });

  it('en webchat NO se encola: ese canal entrega en vivo', async () => {
    const antes = (await pedidos()).length;
    const link = await armarCobro('webchat');
    await confirmar(link);

    const aviso = await avisoDe(link);
    expect(aviso!.delivery_status).toBe('sent');
    expect((await pedidos()).length).toBe(antes);
  });

  it('sin conexión directa a Redis conserva el pedido durable y no dice enviado', async () => {
    const link = await armarCobro('whatsapp');
    // No necesita una función externa para encolar: el mismo commit deja
    // el pedido que retomará el dispatcher cuando Redis esté disponible.
    await withTenant(admin, tenant, (c: PoolClient) =>
      confirmPayment(c, { tenantId: tenant, linkId: link, status: 'paid', amountClp: 15000 }),
    );
    const aviso = await avisoDe(link);
    expect(aviso!.delivery_status).toBe('queued');
    expect(await pedidos()).toContainEqual({ messageId: aviso!.id, policy: 'transactional' });
  });

  it('el pago queda registrado aunque el aviso no salga', async () => {
    const link = await armarCobro('whatsapp');
    await confirmar(link);
    const r = await admin.query('SELECT status FROM payment_links WHERE id = $1', [link]);
    expect(r.rows[0].status).toBe('paid');
  });

  it('repetir el webhook no duplica el comprobante ni su pedido', async () => {
    const link = await armarCobro('whatsapp');
    const antes = (await pedidos()).length;
    await confirmar(link);
    expect((await confirmar(link)).outcome).toBe('already');
    expect((await pedidos()).length).toBe(antes + 1);
  });

  it('si no se puede guardar el pedido durable, revierte el pago para reintentar el webhook', async () => {
    const link = await armarCobro('whatsapp');
    const antes = (await pedidos()).length;

    const conElOutboxCaido = withTenant(admin, tenant, (c: PoolClient) =>
      confirmPayment(clienteSinOutbox(c), {
        tenantId: tenant,
        linkId: link,
        status: 'paid',
        amountClp: 15000,
      }),
    );
    await expect(conElOutboxCaido).rejects.toThrow(OUTBOX_INEXISTENTE);

    // Nada de lo que la transacción alcanzó a escribir queda: el webhook del
    // proveedor va a reintentar, y tiene que encontrar el cobro como estaba.
    expect((await admin.query('SELECT status FROM payment_links WHERE id=$1', [link])).rows[0].status).toBe('sent');
    expect((await admin.query('SELECT id FROM payments WHERE link_id=$1', [link])).rowCount).toBe(0);
    expect(await avisoDe(link)).toBeUndefined();
    expect((await pedidos()).length).toBe(antes);

    // Y el reintento, con el outbox sano, cobra y deja su pedido.
    expect((await confirmar(link)).outcome).toBe('paid');
    expect((await pedidos()).length).toBe(antes + 1);
  });
});
