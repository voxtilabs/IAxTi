import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { salePorProveedor, sendMessage, updateDeliveryStatus } from '@iaxti/module-conversations';
import { moveDealStage } from '@iaxti/module-crm';
import { rowToLink, type PaymentLink } from './links';

// La confirmación (#61, SPEC §17): "saber qué se pagó sin conciliar a
// mano". Idempotente por diseño (UNIQUE payments.link_id) — el mismo
// webhook dos veces no duplica nada.

export interface ConfirmInput {
  tenantId: string;
  linkId: string;
  status: 'paid' | 'failed';
  method?: string | null;
  providerPaymentId?: string | null;
  receiptUrl?: string | null;
  amountClp?: number | null;
  /** settings.pagos.paidStageName: si está, la oportunidad se mueve sola. */
  paidStageName?: string | null;
  requestId?: string;
}

export interface ConfirmResult {
  outcome: 'paid' | 'failed' | 'already' | 'not_found';
  link?: PaymentLink;
}

/**
 * Lo que este caso de uso necesita del mundo de afuera. `enqueueOutbound` lo
 * pasa el worker: el módulo no conoce BullMQ (ADR-0003), igual que en el
 * motor de reglas.
 */
export interface DepsConfirmacion {
  enqueueOutbound?: (job: {
    tenantId: string;
    messageId: string;
    requestId?: string;
  }) => Promise<void>;
}

export async function confirmPayment(
  client: PoolClient,
  input: ConfirmInput,
  deps?: DepsConfirmacion,
): Promise<ConfirmResult> {
  const r = await client.query(
    `SELECT * FROM payment_links WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.linkId],
  );
  if (r.rowCount === 0) return { outcome: 'not_found' };
  const link = rowToLink(r.rows[0]);
  if (link.status === 'paid') return { outcome: 'already', link }; // idempotente

  if (input.status === 'failed') {
    await publishEvent(client, {
      name: 'payment.failed',
      tenantId: input.tenantId,
      payload: { linkId: link.id, conversationId: link.conversationId },
      actor: 'system',
      requestId: input.requestId,
    });
    return { outcome: 'failed', link };
  }

  // El pago manda: si llegó por un link vencido/cancelado, igual se registra.
  const pagado = await client.query(
    `UPDATE payment_links SET status = 'paid', paid_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, link.id],
  );
  await client.query(
    `INSERT INTO payments (tenant_id, link_id, amount_clp, method, provider_payment_id, receipt_url)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, link_id) DO NOTHING`,
    [
      input.tenantId,
      link.id,
      input.amountClp ?? link.amountClp,
      input.method ?? null,
      input.providerPaymentId ?? null,
      input.receiptUrl ?? null,
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: 'system',
    actorKind: 'system',
    action: 'payments.confirmed',
    resource: 'payment_link',
    resourceId: link.id,
    result: 'ok',
    metadata: {
      amountClp: input.amountClp ?? link.amountClp,
      method: input.method ?? null,
      providerPaymentId: input.providerPaymentId ?? null,
    },
    requestId: input.requestId,
  });

  // El aviso en la conversación, con el comprobante si vino.
  //
  // Se escribía y se marcaba 'sent' sin pasar por la cola. En webchat eso
  // está bien —el canal entrega en vivo—, pero en WhatsApp un saliente solo
  // llega si el proveedor lo manda. El cliente pagaba, no recibía nada, y la
  // bandeja mostraba el aviso en verde: si después preguntaba, el vendedor
  // miraba, veía "enviado" y respondía que ya le había avisado.
  if (link.conversationId) {
    try {
      const monto = (input.amountClp ?? link.amountClp).toLocaleString('es-CL');
      const canal = await client.query(
        'SELECT channel FROM conversations WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, link.conversationId],
      );
      const porProveedor = salePorProveedor(String(canal.rows[0]?.channel ?? 'whatsapp'));

      const message = await sendMessage(client, {
        tenantId: input.tenantId,
        conversationId: link.conversationId,
        authorKind: 'system',
        type: 'texto',
        body: `✓ Pago recibido: $${monto} por "${link.concept}".${
          input.receiptUrl ? `\nComprobante: ${input.receiptUrl}` : ''
        }`,
        requestId: input.requestId,
      });

      if (porProveedor) {
        // Queda 'queued' hasta que el proveedor confirme: el estado real lo
        // pone el webhook de entrega. Sin cola conectada se queda 'queued',
        // que es la verdad — un aviso pendiente, no uno entregado.
        await deps?.enqueueOutbound?.({
          tenantId: input.tenantId,
          messageId: message.id,
          requestId: input.requestId,
        });
      } else {
        await updateDeliveryStatus(client, {
          tenantId: input.tenantId,
          messageId: message.id,
          status: 'sent',
          requestId: input.requestId,
        });
      }
    } catch {
      /* una conversación archivada no frena la confirmación */
    }
  }

  // La oportunidad se mueve sola si la etapa de pagado está configurada.
  if (link.dealId && input.paidStageName) {
    try {
      const deal = await client.query(
        'SELECT pipeline_id FROM deals WHERE tenant_id = $1 AND id = $2',
        [input.tenantId, link.dealId],
      );
      if ((deal.rowCount ?? 0) > 0) {
        const etapa = await client.query(
          `SELECT id FROM stages WHERE tenant_id = $1 AND pipeline_id = $2 AND lower(name) = lower($3)`,
          [input.tenantId, deal.rows[0].pipeline_id, input.paidStageName],
        );
        if ((etapa.rowCount ?? 0) > 0) {
          await moveDealStage(client, {
            tenantId: input.tenantId,
            dealId: link.dealId,
            stageId: etapa.rows[0].id,
            requestId: input.requestId,
          });
        }
      }
    } catch {
      /* mover el deal es cortesía: el pago ya quedó registrado */
    }
  }

  await publishEvent(client, {
    name: 'payment.received',
    tenantId: input.tenantId,
    payload: {
      linkId: link.id,
      amountClp: input.amountClp ?? link.amountClp,
      conversationId: link.conversationId,
      dealId: link.dealId,
      contactId: link.contactId,
    },
    actor: 'system',
    requestId: input.requestId,
  });
  return { outcome: 'paid', link: rowToLink(pagado.rows[0]) };
}
