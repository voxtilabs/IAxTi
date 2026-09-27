import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { getTenantSettings } from '@iaxti/module-organizations';
import {
  confirmPayment,
  paymentProviderFor,
  type ProviderKind,
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

export async function processPaymentWebhook(
  pool: Pool,
  data: PaymentWebhookJob,
  fetcher: typeof fetch = fetch,
): Promise<{ outcome: string }> {
  return withTenant(pool, data.tenantId, async (client) => {
    let pago = data.pago;
    // Se pregunta por CÓMO se autentica este proveedor, no por cuál es. Antes
    // decía `providerKind === 'flow'`: un segundo proveedor sin firma entraba
    // con la verificación saltada y nada avisaba. El puerto declara
    // `webhookAuth` y el tipo obliga a que el que declara
    // `consulta-al-proveedor` traiga su consulta.
    const port = paymentProviderFor(data.providerKind as ProviderKind, fetcher);
    if (port.webhookAuth === 'consulta-al-proveedor') {
      // Sin identificador no hay nada que consultar, y el aviso no trae otra
      // cosa: es un webhook que no era de este proveedor o no se entendió.
      if (!pago.providerPaymentId) return { outcome: 'flow_sin_token' };
      const provider = await client.query(
        'SELECT credential_ref, mode FROM payment_providers WHERE tenant_id = $1 AND id = $2',
        [data.tenantId, data.providerId],
      );
      const credentialRef = (provider.rows[0]?.credential_ref as string | undefined) ?? '';
      if (!credentialRef) {
        throw new Error('No encontramos el proveedor de pagos de este webhook: no podemos confirmar el pago.');
      }
      const credentials = process.env[credentialRef];
      // Antes esto devolvía 'flow_sin_estado' y el job terminaba BIEN: el
      // cliente había pagado, el comercio tenía la plata y en IAxTi no
      // quedaba nada. Se nombra la variable, nunca su contenido.
      if (!credentials) {
        throw new Error(
          `Falta la variable ${credentialRef} en este ambiente: sin credenciales no se puede confirmar el pago con Flow.`,
        );
      }
      const resuelto = await port.resolveStatus(
        pago.providerPaymentId,
        credentials,
        provider.rows[0].mode,
      );
      if (!resuelto) return { outcome: 'flow_token_desconocido' };
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
    );
    return { outcome: res.outcome };
  });
}
