import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// La firma de las entregas (#76): HMAC-SHA256 con timestamp — el cliente
// verifica autenticidad Y frescura, estilo Stripe.

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** X-Iaxti-Signature: t=<epoch>,v1=<hmac(t + '.' + body)> */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** La verificación de referencia (documentada para el cliente; y para
 *  probar la nuestra sin espejos). */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const partes = Object.fromEntries(
    header.split(',').map((p) => p.split('=') as [string, string]),
  );
  const t = Number(partes.t);
  if (!Number.isFinite(t) || Math.abs(now - t) > toleranceSeconds) return false;
  const esperado = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const recibido = partes.v1 ?? '';
  const a = Buffer.from(esperado);
  const b = Buffer.from(recibido);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Backoff exponencial en minutos: 1, 2, 4, 8, 16, 32. */
export const MAX_ATTEMPTS = 6;
export function backoffMinutes(attempt: number): number {
  return Math.min(2 ** Math.max(attempt - 1, 0), 32);
}
