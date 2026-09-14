import { createHmac, timingSafeEqual } from 'node:crypto';

// El puerto de proveedores (#60, SPEC §17): crear el link y verificar el
// webhook — cada pasarela chilena habla su dialecto detrás de esta puerta.
// Credenciales SIEMPRE por referencia: llegan como el CONTENIDO de la env
// var que nombra credential_ref, nunca desde la base.

export type ProviderKind = 'flow' | 'webpay' | 'mercadopago' | 'simulado';

export interface CreateLinkInput {
  amountClp: number;
  concept: string;
  /** Nuestro id del link: viaja como commerceOrder para conciliar. */
  linkId: string;
  /** A dónde vuelve el cliente y a dónde confirma el proveedor. */
  returnUrl: string;
  confirmUrl: string;
  payerEmail?: string;
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

export interface PaymentProviderPort {
  kind: ProviderKind;
  createLink(input: CreateLinkInput, credentials: string): Promise<CreatedLink>;
  /** Verifica autenticidad sobre el cuerpo CRUDO (igual que canales, #41). */
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
 * test apunta a sandbox.flow.cl (FLOW_API_BASE lo decide). La confirmación
 * llega con el token; el estado real se consulta a getStatus (#61).
 */
export function createFlowProvider(fetcher: typeof fetch = fetch): PaymentProviderPort {
  const base = () => process.env.FLOW_API_BASE ?? 'https://sandbox.flow.cl/api';
  return {
    kind: 'flow',
    async createLink(input, credentials) {
      const [apiKey, secretKey] = credentials.split(':');
      if (!apiKey || !secretKey) throw new Error('Las credenciales de Flow son "apiKey:secretKey".');
      const params: Record<string, string> = {
        apiKey,
        commerceOrder: input.linkId,
        subject: input.concept,
        currency: 'CLP',
        amount: String(input.amountClp),
        email: input.payerEmail ?? 'pagos@iaxti.cl',
        urlConfirmation: input.confirmUrl,
        urlReturn: input.returnUrl,
      };
      const s = flowSign(params, secretKey);
      const res = await fetcher(`${base()}/payment/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, s }).toString(),
      });
      if (!res.ok) throw new Error(`Flow respondió ${res.status} al crear el pago.`);
      const data = (await res.json()) as { url?: string; token?: string; flowOrder?: number };
      if (!data.url || !data.token) throw new Error('Flow no devolvió el link de pago.');
      return { externalId: String(data.flowOrder ?? data.token), url: `${data.url}?token=${data.token}` };
    },
    verifyWebhook(rawBody, _headers, secret) {
      // Flow confirma con un POST token; la autenticidad se resuelve
      // consultando getStatus FIRMADO (#61) — el token solo abre la puerta.
      const params = new URLSearchParams(rawBody);
      return Boolean(params.get('token')) && Boolean(secret);
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
