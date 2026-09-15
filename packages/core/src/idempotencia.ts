import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Idempotency-Key (SPEC §28).
 *
 * La cabecera estaba documentada en el OpenAPI y permitida por CORS desde el
 * primer día, y no la leía nadie: un POST reintentado creaba el trato dos
 * veces y generaba el link de cobro dos veces. Acá vive la regla; el
 * interceptor de la API solo la llama.
 *
 * El trato con el cliente es el de siempre: misma llave y mismo cuerpo →
 * exactamente la misma respuesta, sin ejecutar nada de nuevo.
 */

export interface Reserva {
  estado: 'nueva' | 'repetida' | 'en_curso' | 'conflicto';
  respuesta?: { status: number; body: unknown };
}

export function huellaDelPedido(body: unknown): string {
  // Cuerpo vacío y `{}` son el mismo pedido: no vale la pena distinguirlos.
  const texto = body === undefined || body === null ? '' : JSON.stringify(body);
  return createHash('sha256').update(texto).digest('hex');
}

/**
 * Reserva la llave o cuenta qué pasó con ella. Una sola ida a la base:
 * el INSERT con ON CONFLICT DO NOTHING es la reserva, y si no reservó,
 * la fila que ya estaba dice el resto.
 */
export async function reservarLlave(
  client: PoolClient,
  input: { tenantId: string; key: string; method: string; path: string; body: unknown },
): Promise<Reserva> {
  const hash = huellaDelPedido(input.body);
  const puesta = await client.query(
    `INSERT INTO idempotency_keys (tenant_id, key, method, path, request_hash)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING key`,
    [input.tenantId, input.key, input.method, input.path, hash],
  );
  if ((puesta.rowCount ?? 0) > 0) return { estado: 'nueva' };

  const previa = await client.query(
    `SELECT method, path, request_hash, response_status, response_body, completed_at
       FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`,
    [input.tenantId, input.key],
  );
  const fila = previa.rows[0];
  if (!fila) return { estado: 'nueva' }; // se limpió entremedio: que siga

  // La misma llave para OTRO pedido es un error del cliente, no un reintento.
  if (fila.request_hash !== hash || fila.method !== input.method || fila.path !== input.path) {
    return { estado: 'conflicto' };
  }
  if (!fila.completed_at) return { estado: 'en_curso' };
  return {
    estado: 'repetida',
    respuesta: { status: fila.response_status as number, body: fila.response_body },
  };
}

/** Guarda la respuesta para que el reintento reciba ESTA y no otra. */
export async function guardarRespuesta(
  client: PoolClient,
  input: { tenantId: string; key: string; status: number; body: unknown },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET response_status = $3, response_body = $4, completed_at = now()
      WHERE tenant_id = $1 AND key = $2`,
    [input.tenantId, input.key, input.status, JSON.stringify(input.body ?? null)],
  );
}

/**
 * Suelta la llave cuando el pedido falló: un 500 no es un resultado que
 * valga la pena repetir para siempre — el cliente tiene que poder
 * reintentar con la misma llave.
 */
export async function soltarLlave(
  client: PoolClient,
  input: { tenantId: string; key: string },
): Promise<void> {
  await client.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [
    input.tenantId,
    input.key,
  ]);
}

/** Las llaves viven 24 h (SPEC §28): pasado eso, el mismo pedido es un pedido nuevo. */
export async function limpiarLlavesVencidas(client: PoolClient, horas = 24): Promise<number> {
  const r = await client.query(
    'DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)',
    [Math.max(1, horas)],
  );
  return r.rowCount ?? 0;
}
