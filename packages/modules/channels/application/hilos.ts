import type { PoolClient } from 'pg';

/**
 * El hilo de cada conversación del lado del proveedor (ADR-0033, #1334).
 *
 * Zernio manda DENTRO de una conversación que ya existe, no a un teléfono. El
 * id de esa conversación se aprende de cada mensaje que entra (`recordarHilo`
 * desde el worker de entrada) y se usa para contestar (`hiloDe` desde el
 * worker de salida). El adaptador no guarda nada: si guardara el hilo en
 * memoria, dos procesos crearían dos conversaciones para el mismo cliente.
 *
 * Todo corre en el `PoolClient` de quien llama, dentro de su transacción y con
 * su `app.tenant_id`: la tabla tiene RLS forzada.
 */

export interface ClaveDelHilo {
  tenantId: string;
  cuentaId: string;
  /** El teléfono del contacto en E.164. */
  peer: string;
}

/**
 * El candado por destinatario (ADR-0033 §4).
 *
 * Crear una conversación en Zernio NO acepta `Idempotency-Key`: dos envíos
 * simultáneos al mismo contacto sin hilo conocido crearían dos conversaciones
 * y le mandarían la plantilla dos veces. Se toma ANTES de leer el hilo y se
 * suelta con la transacción, que es después de recordarlo.
 *
 * `hashtextextended` y no `hashtext`: 64 bits en vez de 32, que es lo que ya
 * usan las concesiones de Google, y baja las colisiones entre destinatarios
 * distintos —una colisión no rompe nada, solo serializa de más—.
 */
export async function tomarCandadoDelHilo(client: PoolClient, clave: ClaveDelHilo): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `hilo:${clave.tenantId}:${clave.cuentaId}:${clave.peer}`,
  ]);
}

export async function hiloDe(client: PoolClient, clave: ClaveDelHilo): Promise<string | null> {
  const r = await client.query<{ provider_thread_id: string }>(
    `SELECT provider_thread_id FROM channel_threads
      WHERE tenant_id = $1 AND channel_account_id = $2 AND peer = $3`,
    [clave.tenantId, clave.cuentaId, clave.peer],
  );
  return r.rows[0]?.provider_thread_id ?? null;
}

/**
 * Último gana: el proveedor es la fuente de verdad del hilo. Si Zernio rehace
 * una conversación, el próximo mensaje que entra trae el id nuevo y ese es el
 * que vale.
 */
export async function recordarHilo(
  client: PoolClient,
  clave: ClaveDelHilo & { hilo: string },
): Promise<void> {
  await client.query(
    `INSERT INTO channel_threads (tenant_id, channel_account_id, peer, provider_thread_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, channel_account_id, peer)
     DO UPDATE SET provider_thread_id = EXCLUDED.provider_thread_id, updated_at = now()
     WHERE channel_threads.provider_thread_id IS DISTINCT FROM EXCLUDED.provider_thread_id`,
    [clave.tenantId, clave.cuentaId, clave.peer, clave.hilo],
  );
}

/** Cuando el proveedor ya no tiene ese hilo (404 → `hilo_vencido`). */
export async function olvidarHilo(client: PoolClient, clave: ClaveDelHilo): Promise<void> {
  await client.query(
    `DELETE FROM channel_threads
      WHERE tenant_id = $1 AND channel_account_id = $2 AND peer = $3`,
    [clave.tenantId, clave.cuentaId, clave.peer],
  );
}
