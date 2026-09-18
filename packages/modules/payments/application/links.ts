import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import {
  paymentProviderFor,
  type PaymentProviderPort,
  type ProviderKind,
} from '../domain/providers';

// Links de pago (#60, SPEC §17): el cierre de la venta desde el chat.
// El monto viene de la oportunidad o se escribe; el USER tiene tope.

export interface PaymentProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  credentialRef: string;
  webhookSecretRef: string | null;
  mode: 'test' | 'live';
  active: boolean;
}

function rowToProvider(row: Record<string, unknown>): PaymentProvider {
  return {
    id: row.id as string,
    kind: row.kind as ProviderKind,
    name: row.name as string,
    credentialRef: row.credential_ref as string,
    webhookSecretRef: (row.webhook_secret_ref as string) ?? null,
    mode: row.mode as 'test' | 'live',
    active: row.active as boolean,
  };
}

export interface PaymentLink {
  id: string;
  providerId: string;
  contactId: string | null;
  conversationId: string | null;
  dealId: string | null;
  amountClp: number;
  concept: string;
  url: string | null;
  status: 'created' | 'sent' | 'paid' | 'expired' | 'cancelled';
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export function rowToLink(row: Record<string, unknown>): PaymentLink {
  return {
    id: row.id as string,
    providerId: row.provider_id as string,
    contactId: (row.contact_id as string) ?? null,
    conversationId: (row.conversation_id as string) ?? null,
    dealId: (row.deal_id as string) ?? null,
    amountClp: Number(row.amount_clp),
    concept: row.concept as string,
    url: (row.url as string) ?? null,
    status: row.status as PaymentLink['status'],
    expiresAt: (row.expires_at as Date) ?? null,
    paidAt: (row.paid_at as Date) ?? null,
    createdAt: row.created_at as Date,
  };
}

/**
 * El modo live cobra dinero real y solo existe en producción (SPEC §17).
 *
 * Vive en una función porque hace falta en DOS momentos distintos, y por
 * mucho tiempo estuvo solo en uno: al dar de alta el proveedor. Eso asume
 * que la única forma de que exista una fila `mode = 'live'` es haberla
 * creado en este mismo ambiente — y no es cierto. Basta restaurar un
 * respaldo de producción en staging, que es algo que se hace, para tener
 * filas live donde no corresponde.
 *
 * Una guarda sobre cómo llegó la fila no protege de lo que la fila es.
 */
export function assertModoPermitido(mode: 'test' | 'live'): void {
  if (mode !== 'live') return;
  const entorno = process.env.IAXTI_ENV ?? 'dev';
  if (entorno === 'production') return;
  throw new Error(
    'El modo live cobra dinero real: en este ambiente los proveedores van siempre en modo test.',
  );
}

export async function addProvider(
  client: PoolClient,
  input: {
    tenantId: string;
    kind: ProviderKind;
    name: string;
    credentialRef: string;
    webhookSecretRef?: string;
    mode?: 'test' | 'live';
    actor: string;
    requestId?: string;
  },
): Promise<PaymentProvider> {
  if (!input.name?.trim()) throw new Error('El proveedor necesita un nombre.');
  if (!input.credentialRef?.trim() || input.credentialRef.includes(' ')) {
    throw new Error('credentialRef es el NOMBRE de la variable de entorno (sin espacios), jamás la credencial.');
  }
  // Paranoia §17: si alguien pega la credencial en vez del nombre, se corta.
  if (/[:=]/.test(input.credentialRef)) {
    throw new Error('Eso parece una credencial. Aquí va el NOMBRE de la variable de entorno.');
  }
  // Modo live SOLO en producción (SPEC §17). La API ya lo verificaba, pero
  // la regla vive en el CASO DE USO (ADR-0008): un proveedor en live cobra
  // dinero de verdad, y no puede depender de por qué puerta se entró —el
  // configurador, una semilla o un panel nuevo entran por otra.
  assertModoPermitido(input.mode ?? 'test');
  const r = await client.query(
    `INSERT INTO payment_providers (tenant_id, kind, name, credential_ref, webhook_secret_ref, mode)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [
      input.tenantId,
      input.kind,
      input.name.trim(),
      input.credentialRef.trim(),
      input.webhookSecretRef?.trim() ?? null,
      input.mode ?? 'test',
    ],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: 'user',
    action: 'payments.provider.add',
    resource: 'payment_provider',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { kind: input.kind, mode: input.mode ?? 'test' },
    requestId: input.requestId,
  });
  return rowToProvider(r.rows[0]);
}

export async function listProviders(client: PoolClient, tenantId: string): Promise<PaymentProvider[]> {
  const r = await client.query(
    'SELECT * FROM payment_providers WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return r.rows.map(rowToProvider);
}

export async function getProviderById(
  client: PoolClient,
  tenantId: string,
  providerId: string,
): Promise<PaymentProvider | null> {
  const r = await client.query(
    'SELECT * FROM payment_providers WHERE tenant_id = $1 AND id = $2',
    [tenantId, providerId],
  );
  return r.rowCount === 0 ? null : rowToProvider(r.rows[0]);
}

export interface CreateLinkInput {
  tenantId: string;
  /** null cuando el cobro es AL TENANT (facturas de billing, #67). */
  contactId: string | null;
  conversationId?: string;
  dealId?: string;
  /** Escrito a mano, o null para tomarlo de la oportunidad. */
  amountClp?: number | null;
  concept: string;
  providerId?: string;
  expiresHours?: number;
  /** El tope del USER (matriz §23); null = sin tope (SUPERVISOR/ADMIN). */
  maxAmountClp?: number | null;
  publicBaseUrl?: string;
  /** null cuando lo crea el sistema (facturas de billing, #67). */
  actorUserId: string | null;
  requestId?: string;
}

/**
 * Crea el link con el proveedor activo. El monto se toma de la
 * oportunidad si no viene escrito; el tope por rol corta ANTES de
 * llamar al proveedor.
 */
export async function createPaymentLink(
  client: PoolClient,
  input: CreateLinkInput,
  portFor: (kind: ProviderKind) => PaymentProviderPort = paymentProviderFor,
): Promise<PaymentLink> {
  if (!input.concept?.trim()) throw new Error('El link necesita un concepto (qué se está cobrando).');
  let amount = input.amountClp ?? null;
  if (amount === null && input.dealId) {
    const deal = await client.query(
      'SELECT value_clp FROM deals WHERE tenant_id = $1 AND id = $2',
      [input.tenantId, input.dealId],
    );
    amount = deal.rows[0]?.value_clp === null || deal.rowCount === 0 ? null : Number(deal.rows[0].value_clp);
  }
  if (!amount || !(amount > 0)) {
    throw new Error('Falta el monto: escríbelo o ponle valor a la oportunidad.');
  }
  amount = Math.round(amount);
  if (input.maxAmountClp != null && amount > input.maxAmountClp) {
    throw new Error(
      `El monto supera tu tope de $${input.maxAmountClp.toLocaleString('es-CL')}. Pídele el link a quien supervisa.`,
    );
  }

  const provider = input.providerId
    ? await getProviderById(client, input.tenantId, input.providerId)
    : (await listProviders(client, input.tenantId)).find((p) => p.active) ?? null;
  if (!provider || !provider.active) {
    throw new Error('Primero conecta un proveedor de pagos en Ajustes → Pagos.');
  }
  // Y otra vez acá, sobre el proveedor que se va a USAR. Comprobarlo solo
  // al darlo de alta protege del alta, no del cobro: una fila live que
  // llegó por otro camino —un respaldo de producción restaurado en
  // staging— cobraba dinero de verdad sin que nada lo mirara.
  assertModoPermitido(provider.mode);

  const credentials = process.env[provider.credentialRef];
  if (!credentials) {
    throw new Error(`Falta la variable ${provider.credentialRef} en este ambiente (credenciales por referencia).`);
  }

  const r = await client.query(
    `INSERT INTO payment_links
       (tenant_id, provider_id, contact_id, conversation_id, deal_id, amount_clp, concept, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(hours => $8), $9) RETURNING *`,
    [
      input.tenantId,
      provider.id,
      input.contactId,
      input.conversationId ?? null,
      input.dealId ?? null,
      amount,
      input.concept.trim(),
      input.expiresHours ?? 72,
      input.actorUserId ?? null,
    ],
  );
  const base = input.publicBaseUrl ?? process.env.PUBLIC_API_URL ?? 'https://api-staging.iaxti.cl';
  const creado = await portFor(provider.kind).createLink(
    {
      amountClp: amount,
      concept: input.concept.trim(),
      linkId: r.rows[0].id,
      returnUrl: `${base}/pagos/gracias`,
      confirmUrl: `${base}/webhooks/payments/${provider.id}`,
    },
    credentials,
  );
  const listo = await client.query(
    `UPDATE payment_links SET external_id = $3, url = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, r.rows[0].id, creado.externalId, creado.url],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actorUserId ?? 'system',
    actorKind: input.actorUserId ? 'user' : 'system',
    action: 'payments.link.create',
    resource: 'payment_link',
    resourceId: r.rows[0].id,
    result: 'ok',
    metadata: { amountClp: amount, provider: provider.kind, mode: provider.mode },
    requestId: input.requestId,
  });
  await publishEvent(client, {
    name: 'payment_link.created',
    tenantId: input.tenantId,
    payload: { linkId: r.rows[0].id, amountClp: amount, dealId: input.dealId ?? null },
    actor: input.actorUserId ?? 'system',
    requestId: input.requestId,
  });
  return rowToLink(listo.rows[0]);
}

export async function markLinkSent(
  client: PoolClient,
  input: { tenantId: string; linkId: string; requestId?: string },
): Promise<void> {
  await client.query(
    `UPDATE payment_links SET status = 'sent', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'created'`,
    [input.tenantId, input.linkId],
  );
  await publishEvent(client, {
    name: 'payment_link.sent',
    tenantId: input.tenantId,
    payload: { linkId: input.linkId },
    actor: 'system',
    requestId: input.requestId,
  });
}

export async function listLinks(
  client: PoolClient,
  tenantId: string,
  filtro: { conversationId?: string; dealId?: string } = {},
): Promise<PaymentLink[]> {
  const r = await client.query(
    `SELECT * FROM payment_links
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR conversation_id = $2)
        AND ($3::uuid IS NULL OR deal_id = $3)
      ORDER BY created_at DESC LIMIT 50`,
    [tenantId, filtro.conversationId ?? null, filtro.dealId ?? null],
  );
  return r.rows.map(rowToLink);
}

export async function cancelLink(
  client: PoolClient,
  input: { tenantId: string; linkId: string; actor: string },
): Promise<void> {
  const r = await client.query(
    `UPDATE payment_links SET status = 'cancelled', updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status IN ('created','sent')`,
    [input.tenantId, input.linkId],
  );
  if (r.rowCount === 0) throw new Error('Ese link ya no se puede cancelar.');
}

/** Vencimientos (job scheduled): created/sent con la fecha pasada. */
export async function expireLinks(client: PoolClient, tenantId: string): Promise<number> {
  const r = await client.query(
    `UPDATE payment_links SET status = 'expired', updated_at = now()
      WHERE tenant_id = $1 AND status IN ('created','sent')
        AND expires_at IS NOT NULL AND expires_at < now()
      RETURNING id`,
    [tenantId],
  );
  for (const fila of r.rows) {
    await publishEvent(client, {
      name: 'payment_link.expired',
      tenantId,
      payload: { linkId: fila.id },
      actor: 'system',
    });
  }
  return r.rowCount ?? 0;
}

/**
 * Los tenants a los que les toca vencer links de pago.
 *
 * De `tenants`, no de `payment_links` (#286): esa tabla tiene RLS y la
 * consulta corre sin contexto, así que con el rol de producción ningún link
 * habría vencido — y un link de pago que no vence es uno que se puede pagar
 * meses después, por un monto que ya no corresponde.
 */
export async function tenantsWithExpirableLinks(client: Pick<PoolClient, 'query'>): Promise<string[]> {
  const r = await client.query(
    `SELECT id FROM tenants WHERE COALESCE(state, 'active') <> 'deleted' ORDER BY created_at`,
  );
  return r.rows.map((x) => x.id);
}

/**
 * El proveedor por id, para el webhook público — que trae el id en la ruta y
 * no el tenant.
 *
 * El comentario que estaba acá decía "el pool del proceso no está bajo RLS".
 * Eso era cierto solo mientras el rol fuera superusuario: con el rol de
 * producción, `payment_providers` tiene RLS FORCE y esta consulta devolvía
 * cero filas — o sea que un pago confirmado por el proveedor no se
 * registraba nunca (#286).
 *
 * Ahora el tenant se averigua primero con `tenantDeProveedor` y esto se
 * llama SIEMPRE dentro de `withTenant`. El tipo pide `PoolClient` y no un
 * pool disfrazado justamente para que eso no se pueda volver a hacer.
 */
export async function findProviderGlobal(
  client: PoolClient,
  providerId: string,
): Promise<(PaymentProvider & { tenantId: string }) | null> {
  const r = await client.query('SELECT * FROM payment_providers WHERE id = $1', [providerId]);
  if (r.rowCount === 0) return null;
  return { ...rowToProvider(r.rows[0]), tenantId: r.rows[0].tenant_id as string };
}

/**
 * El tenant de un proveedor de pagos, para el webhook que llega sin él
 * (#286). Mismo motivo y misma forma que `tenantDeCuenta`: devuelve solo el
 * tenant, y el resto se lee dentro de `withTenant`.
 */
export async function tenantDeProveedor(
  client: Pick<PoolClient, 'query'>,
  providerId: string,
): Promise<string | null> {
  const r = await client.query('SELECT tenant_de_proveedor_de_pago($1) AS tenant', [providerId]);
  return (r.rows[0]?.tenant as string | null) ?? null;
}
