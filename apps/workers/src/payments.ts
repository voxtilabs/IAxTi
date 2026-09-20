import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { getTenantSettings } from '@iaxti/module-organizations';
import {
  confirmPayment,
  flowSign,
  flowConfig,
  type DepsConfirmacion,
  type WebhookPayment,
} from '@iaxti/module-payments';

// La confirmación de pagos (#61) corre en la cola inbound (moduleId
// payments = kill-switch): verifica contra el PROVEEDOR cuando hace
// falta (Flow getStatus firmado) y confirma idempotente.

export interface PaymentWebhookJob {
  moduleId: 'payments';
  tenantId: string;
  providerId: string;
  providerKind: string;
  pago: WebhookPayment;
  requestId?: string;
}

/** Flow (#61): el token del webhook NO es prueba de pago — getStatus sí. */
async function resolveFlowStatus(
  token: string,
  credentials: string,
  mode: 'test' | 'live',
  fetcher: typeof fetch = fetch,
): Promise<WebhookPayment | null> {
  const { base, apiKey, secretKey } = flowConfig(credentials, mode);
  const params = { apiKey, token };
  const s = flowSign(params, secretKey);
  const res = await fetcher(`${base}/payment/getStatus?${new URLSearchParams({ ...params, s })}`, { redirect: 'error' });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    commerceOrder?: string;
    status?: number; // 1 pendiente, 2 pagada, 3 rechazada, 4 anulada
    paymentData?: { media?: string; amount?: number };
    flowOrder?: number;
  };
  if (!data.commerceOrder) return null;
  return {
    linkId: data.commerceOrder,
    status: data.status === 2 ? 'paid' : data.status === 1 ? 'pending' : 'failed',
    method: data.paymentData?.media ?? null,
    providerPaymentId: data.flowOrder ? String(data.flowOrder) : token,
    receiptUrl: null,
    amountClp: Number.isFinite(Number(data.paymentData?.amount)) ? Number(data.paymentData?.amount) : null,
  };
}

export async function processPaymentWebhook(
  pool: Pool,
  data: PaymentWebhookJob,
  fetcher: typeof fetch = fetch,
  deps: DepsConfirmacion = {},
): Promise<{ outcome: string }> {
  return withTenant(pool, data.tenantId, async (client) => {
    let pago = data.pago;
    if (data.providerKind === 'flow' && pago.providerPaymentId) {
      const provider = await client.query(
        'SELECT credential_ref, mode FROM payment_providers WHERE tenant_id = $1 AND id = $2',
        [data.tenantId, data.providerId],
      );
      const credentials = process.env[provider.rows[0]?.credential_ref ?? ''];
      const resuelto = credentials
        ? await resolveFlowStatus(pago.providerPaymentId, credentials, provider.rows[0].mode, fetcher)
        : null;
      if (!resuelto) return { outcome: 'flow_sin_estado' };
      pago = resuelto;
    }
    if (pago.status === 'pending' || !pago.linkId) return { outcome: 'pendiente' };

    const settings = (await getTenantSettings(client, data.tenantId)) as {
      pagos?: { paidStageName?: string };
    };
    const res = await confirmPayment(
      client,
      {
        tenantId: data.tenantId,
        linkId: pago.linkId,
        status: pago.status,
        method: pago.method,
        providerPaymentId: pago.providerPaymentId,
        receiptUrl: pago.receiptUrl,
        amountClp: pago.amountClp,
        paidStageName: settings.pagos?.paidStageName ?? null,
        requestId: data.requestId,
      },
      // La cola de salida: sin esto el aviso de "pago recibido" se escribía
      // en la bandeja y nunca salía al cliente.
      deps,
    );
    return { outcome: res.outcome };
  });
}
