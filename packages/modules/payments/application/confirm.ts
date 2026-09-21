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

export async function confirmPayment(
  client: PoolClient,
  input: ConfirmInput,
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

  // Pago y pedido durable confirman juntos. Si PostgreSQL falla, el webhook
  // debe reintentarse; Redis no participa en esta transacción.
  if (link.conversationId) {
    const monto = (input.amountClp ?? link.amountClp).toLocaleString('es-CL');
    const canal = await client.query(
      'SELECT channel FROM conversations WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, link.conversationId],
    );
    const message = await sendMessage(client, {
      tenantId: input.tenantId,
      conversationId: link.conversationId,
      authorKind: 'system',
      type: 'texto',
      delivery: 'transactional',
      body: `✓ Pago recibido: $${monto} por "${link.concept}".${
        input.receiptUrl ? `\nComprobante: ${input.receiptUrl}` : ''
      }`,
      requestId: input.requestId,
    });
    if (!salePorProveedor(String(canal.rows[0]?.channel ?? 'whatsapp'))) {
      await updateDeliveryStatus(client, {
        tenantId: input.tenantId, messageId: message.id, status: 'sent', requestId: input.requestId,
      });
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
