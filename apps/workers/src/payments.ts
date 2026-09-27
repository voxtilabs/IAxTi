import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { getTenantSettings } from '@iaxti/module-organizations';
import {
  confirmPayment,
  flowSign,
  flowConfig,
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

/**
 * Flow (#61): el token del webhook NO es prueba de pago — getStatus sí.
 *
 * Devuelve null SOLO cuando Flow contestó y su respuesta es definitiva (no
 * reconoce el token). Todo lo demás —caída de Flow, respuesta ilegible, la red
 * cortada— LANZA: Flow avisa una sola vez, así que un job que termina bien sin
 * saber el estado del pago es un pago perdido para siempre. Lanzar deja que la
 * cola reintente (ver los `attempts` con los que se encola el webhook).
 *
 * Lo que esto NO cubre: un pago que Flow todavía da por pendiente. Ahí Flow sí
 * contestó, y volver a preguntar lo mismo al tiro no sirve; hace falta un
 * barrido que reconcilie los links pendientes más tarde, y ese barrido todavía
 * no existe.
 */
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
  // 5xx/429 es "vuelve a preguntar"; 4xx es "este token no es una orden mía".
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`Flow respondió ${res.status} al consultar el estado del pago: hay que reintentar.`);
  }
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
): Promise<{ outcome: string }> {
  return withTenant(pool, data.tenantId, async (client) => {
    let pago = data.pago;
    if (data.providerKind === 'flow') {
      // Sin token no hay nada que consultar, y el aviso de Flow no trae otra
      // cosa: es un webhook que no era de Flow o no se entendió.
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
      const resuelto = await resolveFlowStatus(
        pago.providerPaymentId,
        credentials,
        provider.rows[0].mode,
        fetcher,
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
