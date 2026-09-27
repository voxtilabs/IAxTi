import { createHmac, timingSafeEqual } from 'node:crypto';
import { flowConfig } from './flow-config';

// El puerto de proveedores (#60, SPEC §17): crear el link y verificar el
// webhook — cada pasarela chilena habla su dialecto detrás de esta puerta.
// Credenciales SIEMPRE por referencia: llegan como el CONTENIDO de la env
// var que nombra credential_ref, nunca desde la base.

export type ProviderKind = 'flow' | 'webpay' | 'mercadopago' | 'simulado';

export interface CreateLinkInput {
  /** Modo del registro del proveedor; omitido conserva test por seguridad. */
  mode?: 'test' | 'live';
  amountClp: number;
  concept: string;
  /** Nuestro id del link: viaja como commerceOrder para conciliar. */
  linkId: string;
  /** A dónde vuelve el cliente y a dónde confirma el proveedor. */
  returnUrl: string;
  confirmUrl: string;
  /**
   * Hasta cuándo se puede pagar. NO es opcional: el vencimiento tiene que
   * viajar al proveedor, porque el de nuestra tabla no lo conoce nadie más
   * (ver `timeout` en el adaptador de Flow).
   */
  expiresAt: Date;
  /**
   * El email del PAGADOR. Lo decide el caso de uso, que es el único que sabe
   * a quién se le está cobrando; el adaptador no inventa direcciones.
   */
  payerEmail: string;
}

export interface CreatedLink {
  externalId: string;
  url: string;
}

export interface WebhookPayment {
  /** Nuestro linkId (viajó como commerceOrder). */
  linkId: string;
  status: 'paid' | 'failed' | 'pending';
  method: string | null;
  providerPaymentId: string | null;
  receiptUrl: string | null;
  amountClp: number | null;
}

/**
 * De dónde sale la autenticidad de la confirmación, que NO es la misma
 * historia en todas las pasarelas:
 *
 * - `firma-en-el-cuerpo`: el proveedor firma el cuerpo con un secreto
 *   compartido y `verifyWebhook` la comprueba. Sin secreto configurado no se
 *   puede confiar en nada: la puerta se cierra.
 * - `consulta-al-proveedor`: el proveedor manda un aviso SIN firma (Flow:
 *   un POST con el token y nada más) y la autenticidad se resuelve después,
 *   preguntándole al proveedor por un canal firmado por nosotros. Acá el
 *   aviso es solo eso —un aviso—, y exigirle un secreto que el proveedor
 *   nunca manda es cerrarle la puerta a todos los pagos de verdad.
 */
export type WebhookAuthKind = 'firma-en-el-cuerpo' | 'consulta-al-proveedor';

export interface PaymentProviderPort {
  kind: ProviderKind;
  /** Cómo se autentica la confirmación de ESTE proveedor. */
  webhookAuth: WebhookAuthKind;
  createLink(input: CreateLinkInput, credentials: string): Promise<CreatedLink>;
  /**
   * Verifica autenticidad sobre el cuerpo CRUDO (igual que canales, #41).
   * Solo tiene sentido con `webhookAuth: 'firma-en-el-cuerpo'`; el resto
   * devuelve false, porque no hay firma que verificar.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean;
  parseWebhook(rawBody: string): WebhookPayment | null;
}

/** Firma de Flow: HMAC-SHA256 hex sobre los params concatenados en orden
 *  alfabético (nombre+valor), con la secretKey. */
export function flowSign(params: Record<string, string>, secretKey: string): string {
  const base = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('');
  return createHmac('sha256', secretKey).update(base).digest('hex');
}

function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Flow (flow.cl): credenciales "apiKey:secretKey" en la env var. En modo
 * test solo admite sandbox.flow.cl; live solo el destino oficial en producción. La confirmación
 * llega con el token; el estado real se consulta a getStatus (#61).
 */
export function createFlowProvider(fetcher: typeof fetch = fetch): PaymentProviderPort {
  return {
    kind: 'flow',
    // Flow confirma con un POST x-www-form-urlencoded que lleva SOLO el
    // token: ni firma, ni cabecera, ni secreto compartido
    // (developers.flow.cl, "Confirmación de orden"). Lo que prueba el pago es
    // el getStatus firmado que hace el worker.
    webhookAuth: 'consulta-al-proveedor',
    async createLink(input, credentials) {
      const { base, apiKey, secretKey } = flowConfig(credentials, input.mode);
      if (!input.payerEmail?.trim()) {
        throw new Error('Falta el email del pagador: Flow lo exige para crear la orden.');
      }
      // `timeout` en SEGUNDOS. La doc de Flow es explícita: "Si no se envía
      // este parámetro la orden no expirará y estará vigente para pago por
      // tiempo indefinido". Sin él, nuestro vencimiento vivía solo en
      // payment_links: un link 'expired' o 'cancelled' acá seguía siendo
      // pagable en Flow, y el que la peluquería mandó en marzo se pagaba en
      // septiembre al precio de marzo.
      const segundos = Math.floor((input.expiresAt.getTime() - Date.now()) / 1000);
      if (!(segundos > 0)) {
        throw new Error('El link ya está vencido: no se crea una orden de pago que nadie debería poder pagar.');
      }
      const params: Record<string, string> = {
        apiKey,
        commerceOrder: input.linkId,
        subject: input.concept,
        currency: 'CLP',
        amount: String(input.amountClp),
        email: input.payerEmail.trim(),
        urlConfirmation: input.confirmUrl,
        urlReturn: input.returnUrl,
        timeout: String(segundos),
      };
      const s = flowSign(params, secretKey);
      const res = await fetcher(`${base}/payment/create`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, s }).toString(),
      });
      if (!res.ok) throw new Error(`Flow respondió ${res.status} al crear el pago.`);
      const data = (await res.json()) as { url?: string; token?: string; flowOrder?: number };
      if (!data.url || !data.token) throw new Error('Flow no devolvió el link de pago.');
      return { externalId: String(data.flowOrder ?? data.token), url: `${data.url}?token=${data.token}` };
    },
    verifyWebhook() {
      // Flow no firma nada, así que acá no hay nada que verificar y se
      // responde false. Antes esto devolvía `token presente && secreto
      // presente`, que no verificaba autenticidad —cualquiera puede mandar un
      // token— y sí exigía un secreto: el resultado era 401 a la confirmación
      // de todos los pagos reales. La autenticidad la da `getStatus` firmado;
      // por eso este adaptador declara `webhookAuth: 'consulta-al-proveedor'`
      // y el guard del webhook no llama a esta función.
      return false;
    },
    parseWebhook(rawBody) {
      const params = new URLSearchParams(rawBody);
      const token = params.get('token');
      if (!token) return null;
      // El worker consulta getStatus con este token (#61): aquí solo viaja.
      return {
        linkId: '',
        status: 'pending',
        method: null,
        providerPaymentId: token,
        receiptUrl: null,
        amountClp: null,
      };
    },
  };
}

/**
 * El simulador (staging y tests, mismo rol que el canal simulador #36):
 * links ficticios y webhook firmado con HMAC X-Iaxti-Pay-Signature.
 */
export function createSimuladoProvider(): PaymentProviderPort {
  return {
    kind: 'simulado',
    webhookAuth: 'firma-en-el-cuerpo',
    async createLink(input) {
      return {
        externalId: `sim-${input.linkId}`,
        url: `https://pagos-simulados.iaxti.cl/${input.linkId}`,
      };
    },
    verifyWebhook(rawBody, headers, secret) {
      const firma = headers['x-iaxti-pay-signature'] ?? '';
      return Boolean(firma) && safeEq(firma, hmacHex(secret, rawBody));
    },
    parseWebhook(rawBody) {
      try {
        const data = JSON.parse(rawBody) as Record<string, unknown>;
        if (typeof data.linkId !== 'string') return null;
        return {
          linkId: data.linkId,
          status: data.status === 'paid' ? 'paid' : data.status === 'failed' ? 'failed' : 'pending',
          method: typeof data.method === 'string' ? data.method : null,
          providerPaymentId: typeof data.paymentId === 'string' ? data.paymentId : null,
          receiptUrl: typeof data.receiptUrl === 'string' ? data.receiptUrl : null,
          amountClp: Number.isFinite(Number(data.amount)) ? Number(data.amount) : null,
        };
      } catch {
        return null;
      }
    },
  };
}

const REGISTRO = new Map<ProviderKind, PaymentProviderPort>();

export function registerPaymentProvider(port: PaymentProviderPort): void {
  REGISTRO.set(port.kind, port);
}

export function paymentProviderFor(kind: ProviderKind): PaymentProviderPort {
  const port = REGISTRO.get(kind);
  if (!port) throw new Error(`No hay adaptador para el proveedor "${kind}" todavía.`);
  return port;
}

registerPaymentProvider(createSimuladoProvider());
registerPaymentProvider(createFlowProvider());
