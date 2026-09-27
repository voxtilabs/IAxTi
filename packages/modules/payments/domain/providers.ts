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

interface PaymentProviderBase {
  kind: ProviderKind;
  createLink(input: CreateLinkInput, credentials: string): Promise<CreatedLink>;
  /**
   * Verifica autenticidad sobre el cuerpo CRUDO (igual que canales, #41).
   * Solo tiene sentido con `webhookAuth: 'firma-en-el-cuerpo'`; el resto
   * devuelve false, porque no hay firma que verificar.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>, secret: string): boolean;
  parseWebhook(rawBody: string): WebhookPayment | null;
}

/**
 * El puerto es una unión discriminada por `webhookAuth`, y no una interfaz con
 * un método opcional, por un motivo concreto de este repo: declarar
 * `consulta-al-proveedor` y no implementar la consulta es exactamente la forma
 * del defecto que se repite acá —declarado en un lado, aplicado en ninguno— y
 * el compilador lo puede impedir.
 *
 * El worker deja de preguntar «¿es Flow?» —que era ramificar por el nombre del
 * proveedor— y pregunta «¿este proveedor se autentica consultándole?». Un
 * segundo proveedor sin firma no puede entrar con la verificación saltada: no
 * compila sin su `resolveStatus`.
 */
export type PaymentProviderPort =
  | (PaymentProviderBase & {
      /** Cómo se autentica la confirmación de ESTE proveedor. */
      webhookAuth: 'firma-en-el-cuerpo';
    })
  | (PaymentProviderBase & {
      webhookAuth: 'consulta-al-proveedor';
      /**
       * Le pregunta al proveedor, por un canal que firmamos nosotros, qué pasó
       * de verdad con este pago.
       *
       * Devuelve null SOLO cuando la respuesta es definitiva: el proveedor
       * contestó y ese identificador no es una orden suya. Todo lo demás
       * —proveedor caído, credencial mala, firma mala, cuerpo ilegible, red
       * cortada— LANZA, para que la cola reintente. El proveedor avisa una sola
       * vez: un job que termina bien sin saber el estado del pago es un pago
       * perdido para siempre.
       */
      resolveStatus(
        providerPaymentId: string,
        credentials: string,
        mode: 'test' | 'live',
      ): Promise<WebhookPayment | null>;
    });

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
/**
 * Los códigos de Flow que dan el asunto por CERRADO.
 *
 * Está vacío, y es a propósito. Decidir por el status HTTP —«4xx es que Flow no
 * conoce este token»— pierde el pago, porque Flow contesta **400 con un código
 * en el cuerpo** para todos sus errores. Comprobado contra el proveedor:
 *
 *     GET https://sandbox.flow.cl/api/payment/getStatus  (apiKey inválida)
 *     → HTTP 400 {"code":109,"message":"Invalid ApiKey"}
 *
 * O sea: secreto rotado en el panel de Flow, credenciales de prueba pegadas en
 * la fila `live`, un carácter de más → 400 → «Flow no conoce este token» → el
 * job termina BIEN. El cliente pagó, el comercio tiene la plata, y en IAxTi no
 * queda nada.
 *
 * No sabemos el número que Flow usa para «esa orden no existe», y adivinarlo es
 * lo que pierde la plata. Así que la lista arranca vacía: **cualquier código
 * lanza**, el job reintenta sus 8 veces y queda en `failed`, visible. Cuando
 * alguien vea un código concreto en un job fallado, lo agrega acá con su número
 * y su motivo — y no antes.
 *
 * El costo de tenerla vacía son reintentos sobre un token que Flow no conoce, y
 * está acotado: el webhook exige autenticación, así que un aviso inventado no
 * llega hasta acá. El camino definitivo que sí queda vivo es el otro: Flow
 * contesta 200 y no trae `commerceOrder`.
 */
const CODIGOS_DEFINITIVOS_DE_FLOW = new Set<number>();

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
    /**
     * getStatus firmado: esto —y no el token del aviso— es lo que prueba el pago.
     *
     * Vive acá, con el adaptador que sabe hablar Flow, y no en el worker: el
     * worker no tiene por qué saber que Flow existe.
     */
    async resolveStatus(token, credentials, mode) {
      const { base, apiKey, secretKey } = flowConfig(credentials, mode);
      const params = { apiKey, token };
      const s = flowSign(params, secretKey);
      const res = await fetcher(
        `${base}/payment/getStatus?${new URLSearchParams({ ...params, s })}`,
        { redirect: 'error' },
      );
      if (res.status >= 500 || res.status === 429) {
        throw new Error(
          `Flow respondió ${res.status} al consultar el estado del pago: hay que reintentar.`,
        );
      }
      const data = (await res.json().catch(() => null)) as {
        commerceOrder?: string;
        status?: number; // 1 pendiente, 2 pagada, 3 rechazada, 4 anulada
        paymentData?: { media?: string; amount?: number };
        flowOrder?: number;
        code?: number;
        message?: string;
      } | null;
      // Un cuerpo ilegible NO es «no conoce el token»: es que no sabemos nada.
      if (!data) {
        throw new Error(
          `Flow contestó ${res.status} con algo que no pudimos leer al consultar el estado del pago: hay que reintentar.`,
        );
      }
      // El código del CUERPO manda, no el status HTTP. Comprobado contra el
      // proveedor: una apiKey inválida responde 400 {"code":109,"message":
      // "Invalid ApiKey"}, y decidir por el status convierte «no puedo hablar
      // con Flow» en «Flow no conoce este token» — que termina el job bien y
      // pierde el pago. Ver CODIGOS_DEFINITIVOS_DE_FLOW.
      if (typeof data.code === 'number') {
        if (!CODIGOS_DEFINITIVOS_DE_FLOW.has(data.code)) {
          throw new Error(
            `Flow rechazó la consulta con el código ${data.code} (${data.message ?? 'sin mensaje'}). ` +
              'Mientras no sepamos el estado del pago, este aviso se reintenta.',
          );
        }
        return null;
      }
      if (!res.ok) {
        throw new Error(
          `Flow respondió ${res.status} sin código al consultar el estado del pago: hay que reintentar.`,
        );
      }
      // Flow contestó bien y no hay orden: ese token no es una orden suya. Es
      // el único camino que termina el job sin saber de un pago.
      if (!data.commerceOrder) return null;
      return {
        linkId: data.commerceOrder,
        status: data.status === 2 ? 'paid' : data.status === 1 ? 'pending' : 'failed',
        method: data.paymentData?.media ?? null,
        providerPaymentId: data.flowOrder ? String(data.flowOrder) : token,
        receiptUrl: null,
        amountClp: Number.isFinite(Number(data.paymentData?.amount))
          ? Number(data.paymentData?.amount)
          : null,
      };
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

/**
 * El registro guarda FÁBRICAS y no instancias, porque el `fetch` se inyecta.
 *
 * Antes guardaba el adaptador ya construido con el `fetch` global, y el worker
 * arrastraba su propio `fetcher` para las pruebas. Con la consulta al proveedor
 * viviendo en el adaptador —donde corresponde— el adaptador es el que tiene que
 * poder recibirlo, o la prueba termina saliendo a internet de verdad.
 */
const REGISTRO = new Map<ProviderKind, (fetcher: typeof fetch) => PaymentProviderPort>();

export function registerPaymentProvider(
  kind: ProviderKind,
  crear: (fetcher: typeof fetch) => PaymentProviderPort,
): void {
  REGISTRO.set(kind, crear);
}

export function paymentProviderFor(
  kind: ProviderKind,
  fetcher: typeof fetch = fetch,
): PaymentProviderPort {
  const crear = REGISTRO.get(kind);
  if (!crear) throw new Error(`No hay adaptador para el proveedor "${kind}" todavía.`);
  return crear(fetcher);
}

registerPaymentProvider('simulado', () => createSimuladoProvider());
registerPaymentProvider('flow', (fetcher) => createFlowProvider(fetcher));
