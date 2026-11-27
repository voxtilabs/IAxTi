import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { writeAudit, type ActorKind } from '@iaxti/module-audit';

/**
 * Los secretos de un canal guardados en la custodia cifrada (#1393, ADR-0038).
 *
 * Hasta acá la cuenta guardaba el NOMBRE de una variable de entorno (SPEC
 * §17), y eso obligaba a tocar el despliegue por cada negocio que conectaba
 * su WhatsApp. Ahora puede guardar, además, una referencia a la custodia de
 * ADR-0028 —el mismo almacén cifrado de los tokens de Google—, y la llave no
 * pasa ni por la base ni por el navegador: va de Zernio a la custodia.
 *
 * La referencia sigue siendo una referencia, nunca el valor:
 *
 *     cu:<espacio>/secrets/iaxti-canal-<tenant>-<cuenta>-<cual>-<azar>/versions/<n>
 *
 * El id lleva el tenant y la cuenta para que una referencia copiada a otra
 * fila —por un error o a propósito— no se resuelva: quien lee comprueba que
 * el id sea DE ESTA cuenta y DE ESTE tipo de secreto. Es la misma defensa que
 * ya tenía el secreto del webhook (`isChannelSecretRef`).
 */
export const PREFIJO_CUSTODIA = 'cu:';

/** Qué secreto del canal es: la llave del proveedor o el secreto del webhook. */
export type SecretoDelCanal = 'llave' | 'webhook';

function prefijoDelId(tenantId: string, accountId: string, cual: SecretoDelCanal): string {
  return `iaxti-canal-${tenantId.replaceAll('-', '')}-${accountId.replaceAll('-', '')}-${cual}-`;
}

/**
 * Un id nuevo para guardar un secreto de esta cuenta. Lleva azar para que
 * reconectar no reuse la carpeta de la llave anterior: la vieja se destruye
 * DESPUÉS de que la fila apunte a la nueva, nunca antes.
 */
export function idDeSecretoDelCanal(tenantId: string, accountId: string, cual: SecretoDelCanal): string {
  return `${prefijoDelId(tenantId, accountId, cual)}${randomBytes(16).toString('hex')}`;
}

const REFERENCIA = /^cu:((?:[A-Za-z0-9_-]{1,64}|projects\/[a-z0-9-]{1,30})\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/[1-9][0-9]{0,19})$/;

/**
 * La referencia que entiende el almacén, si `ref` es una referencia a la
 * custodia de ESTA cuenta y de ESTE secreto. Si no, `null` — y quien lee la
 * trata como «no hay credencial», no como un error que deja pasar.
 */
export function referenciaEnCustodia(
  ref: string | null | undefined,
  tenantId: string,
  accountId: string,
  cual: SecretoDelCanal,
): string | null {
  const m = typeof ref === 'string' ? REFERENCIA.exec(ref) : null;
  if (!m) return null;
  const prefijo = prefijoDelId(tenantId, accountId, cual);
  const id = m[2]!;
  if (!id.startsWith(prefijo) || !/^[a-f0-9]{32}$/.test(id.slice(prefijo.length))) return null;
  return m[1]!;
}

/** El id del secreto dentro de una referencia ya validada (para destruirlo). */
export function idEnLaReferencia(referencia: string): string | null {
  return /\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\//.exec(referencia)?.[1] ?? null;
}

/**
 * Apunta la cuenta a sus secretos en la custodia y lo audita, en la misma
 * transacción.
 *
 * Es la ÚNICA escritura de `credential_ref` y `webhook_secret_ref` después
 * del alta, y por eso vive en el módulo dueño de la tabla. Solo acepta
 * referencias de esta cuenta: un caller no puede apuntarla al secreto de otra.
 * Devuelve las referencias que había, para que quien llama destruya las de la
 * custodia una vez confirmado esto.
 */
export async function fijarSecretosDelCanal(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    credentialRef: string;
    webhookSecretRef: string;
    actor: string;
    actorKind: ActorKind;
    requestId?: string;
  },
): Promise<{ antes: { credentialRef: string | null; webhookSecretRef: string | null } }> {
  if (
    !referenciaEnCustodia(input.credentialRef, input.tenantId, input.accountId, 'llave') ||
    !referenciaEnCustodia(input.webhookSecretRef, input.tenantId, input.accountId, 'webhook')
  ) {
    throw new Error('Las referencias no son de la custodia de esta cuenta.');
  }
  const previo = await client.query(
    `SELECT credential_ref, webhook_secret_ref FROM channel_accounts
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.accountId],
  );
  if (previo.rowCount === 0) throw new Error('No encontramos ese canal.');
  await client.query(
    `UPDATE channel_accounts SET credential_ref = $3, webhook_secret_ref = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.accountId, input.credentialRef, input.webhookSecretRef],
  );
  const antes = {
    credentialRef: (previo.rows[0].credential_ref as string | null) ?? null,
    webhookSecretRef: (previo.rows[0].webhook_secret_ref as string | null) ?? null,
  };
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: input.actorKind,
    action: 'channel.secrets.stored',
    resource: 'channel_account',
    resourceId: input.accountId,
    result: 'ok',
    // Solo DÓNDE estaban y dónde quedaron, por tipo: ni el valor ni la
    // referencia completa, que no le sirve a quien lee la auditoría.
    metadata: {
      credencialAntes: tipoDeReferencia(antes.credentialRef),
      secretoAntes: tipoDeReferencia(antes.webhookSecretRef),
      ahora: 'custodia',
    },
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return { antes };
}

function tipoDeReferencia(ref: string | null): 'custodia' | 'entorno' | 'ninguna' {
  if (!ref) return 'ninguna';
  return ref.startsWith(PREFIJO_CUSTODIA) ? 'custodia' : 'entorno';
}
