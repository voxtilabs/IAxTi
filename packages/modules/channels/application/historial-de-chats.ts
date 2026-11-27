import type { PoolClient } from 'pg';

/**
 * El historial de chats en la configuración de la cuenta (#1406, ADR-0039).
 *
 * `channels` es el dueño de `channel_accounts`: lo que otra parte del
 * producto necesite escribir en su `config` pasa por acá, igual que
 * `fijarSecretosDelCanal` (#1393) fue la única escritura de las referencias
 * de secretos. Esta es la única escritura de `config.historial` — la marca
 * de que el dueño autorizó leer los chats del número, y después el estado
 * de esa lectura mientras el job avanza.
 *
 * No toca nada más de la fila: ni estado, ni referencias, ni el resto del
 * jsonb. La auditoría la escribe quien llama (el módulo whatsapp, con las
 * acciones `whatsapp.historial.autorizado` / `.retirado` que nombra el
 * ADR), en la MISMA transacción que recibe acá.
 */

/**
 * La marca de la autorización y su avance.
 *
 * `estado` arranca en `esperando` al autorizar y lo va moviendo el job con
 * lo que contesta Meta: `requested`, `declined`, `already_synced`,
 * `refused`, `imported`, `listo`, `sin_resultados` o `vencido`. Quién la
 * autorizó y cuándo viaja siempre: retirar y volver a autorizar tiene que
 * dejar rastro de cada decisión.
 */
export interface HistorialDeChats {
  estado:
    | 'esperando'
    | 'requested'
    | 'declined'
    | 'already_synced'
    | 'refused'
    | 'imported'
    | 'listo'
    | 'sin_resultados'
    | 'vencido';
  /** El usuario que autorizó. Se conserva al pasar de estado. */
  autorizadoPor: string;
  /** ISO. Idem. */
  autorizadoEl: string;
}

/**
 * Escribe (o retira) `config.historial` de la cuenta.
 *
 * `historial` en null RETIRA la marca: `config - 'historial'`, no un
 * `null` escrito — «autorización retirada» y «nunca autorizado» no tienen
 * por qué verse distinto en la cuenta, y el rastro de la retirada queda en
 * la auditoría, no en un estado zombi que la pantalla tendría que adivinar.
 */
export async function fijarHistorialDeChats(
  client: PoolClient,
  input: {
    tenantId: string;
    accountId: string;
    historial: HistorialDeChats | null;
  },
): Promise<void> {
  const previo = await client.query<{ historial: unknown }>(
    `SELECT config->'historial' AS historial FROM channel_accounts
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.accountId],
  );
  if (previo.rowCount === 0) throw new Error('No encontramos ese canal.');
  if (input.historial === null) {
    await client.query(
      `UPDATE channel_accounts SET config = config - 'historial', updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.accountId],
    );
    return;
  }
  await client.query(
    `UPDATE channel_accounts SET config = jsonb_set(config, '{historial}', $3::jsonb), updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.accountId, JSON.stringify(input.historial)],
  );
}

/**
 * El `config.historial` de la cuenta, tal como está.
 *
 * Devuelve `null` si no hay marca (nunca se autorizó, o se retiró). No
 * consulta nada afuera: el estado de Meta lo pregunta quien lo necesita.
 */
export async function historialDeChats(
  client: PoolClient,
  input: { tenantId: string; accountId: string },
): Promise<HistorialDeChats | null> {
  const r = await client.query<{ historial: unknown }>(
    `SELECT config->'historial' AS historial FROM channel_accounts
      WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.accountId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese canal.');
  const h = r.rows[0].historial;
  if (!h || typeof h !== 'object') return null;
  return h as HistorialDeChats;
}
