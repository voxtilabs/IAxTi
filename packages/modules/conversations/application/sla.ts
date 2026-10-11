import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings, minutosHabilesEntre } from '../domain/horario';

export interface AlertSweepResult {
  unattended: string[];
  breached: string[];
  /** Las pospuestas cuya fecha llegó, ya despiertas (#819). */
  despertadas: string[];
}

/**
 * El barrido del job programado (#38, cada minuto por tenant activo):
 * (1) `new` sin dueño por más de N minutos → `conversation.unattended`
 *     (el aviso al supervisor; notifications lo convierte en campana en F3);
 * (2) sin primera respuesta tras el SLA en MINUTOS HÁBILES →
 *     `sla.first_response_breached`. Ambos una sola vez por conversación.
 * (3) `snoozed` cuya fecha ya pasó → despierta (#819).
 */
export async function checkConversationAlerts(
  client: PoolClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<AlertSweepResult> {
  const settings = bandejaSettings(await getTenantSettings(client, tenantId));

  const sinDueno = await client.query(
    `UPDATE conversations SET unattended_alerted_at = $3, updated_at = now()
      WHERE tenant_id = $1 AND state = 'new' AND owner_id IS NULL
        AND unattended_alerted_at IS NULL
        AND created_at < $3::timestamptz - make_interval(mins => $2)
      RETURNING id, created_at`,
    [tenantId, settings.alertaSinDuenoMinutos, now],
  );
  for (const row of sinDueno.rows) {
    await publishEvent(client, {
      name: 'conversation.unattended',
      tenantId,
      payload: {
        conversationId: row.id,
        waitingMinutes: Math.floor((now.getTime() - row.created_at.getTime()) / 60_000),
      },
      actor: 'system',
    });
  }

  // Prefiltro barato en SQL (los minutos hábiles nunca superan a los de
  // reloj); el cálculo fino, en dominio.
  const candidatas = await client.query(
    `SELECT id, created_at FROM conversations
      WHERE tenant_id = $1 AND state IN ('new','open')
        AND first_response_at IS NULL AND sla_breached_at IS NULL
        AND created_at < $3::timestamptz - make_interval(mins => $2)`,
    [tenantId, settings.slaPrimeraRespuestaMinutos, now],
  );
  const breached: string[] = [];
  for (const row of candidatas.rows) {
    const habiles = minutosHabilesEntre(row.created_at, now, settings.horario);
    if (habiles <= settings.slaPrimeraRespuestaMinutos) continue;
    await client.query(
      'UPDATE conversations SET sla_breached_at = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId, row.id, now],
    );
    await publishEvent(client, {
      name: 'sla.first_response_breached',
      tenantId,
      payload: { conversationId: row.id, businessMinutes: habiles },
      actor: 'system',
    });
    breached.push(row.id);
  }
  return {
    unattended: sinDueno.rows.map((r) => r.id),
    breached,
    despertadas: await despertarPospuestas(client, tenantId, now),
  };
}

/**
 * Las conversaciones pospuestas cuya fecha llegó (#819).
 *
 * `snoozed_until` se exigía al posponer («snoozed exige fecha»), se guardaba y
 * se mostraba, y tenía exactamente tres lectores: dos mapeos a DTO y la
 * migración que crea la columna. **Ninguno era un reloj.**
 *
 * Así que la mitad de la promesa que le da nombre al estado no existía. El
 * comentario de la máquina de estados dice «despierta por fecha o por
 * mensaje», y solo lo segundo pasaba: quien posponía una conversación para el
 * lunes dependía de que el cliente escribiera.
 *
 * Y si no escribía, se quedaba `snoozed` **para siempre**: no la cierra el
 * cierre automático (que solo mira `open`/`pending`), no la borra la retención
 * (que excluye `new/open/snoozed`), no entra al SLA ni al aviso de sin
 * atender, y se hunde en la lista ordenada por `last_message_at`. Un
 * seguimiento perdido en el único estado que el producto creó para no
 * perderlo.
 *
 * ## A dónde despierta
 *
 * A lo mismo que cuando despierta por un mensaje, y por la misma razón: con
 * dueño vuelve a sus manos (`open`), sin dueño a la cola (`new`). Esa regla ya
 * estaba escrita dos veces —en el comentario de la máquina de estados y en
 * `receiveInbound`— y acá se cumple igual, para que no haya dos maneras de
 * despertar.
 *
 * ## Por qué un UPDATE y no `changeConversationState` fila por fila
 *
 * Porque esto corre cada minuto por cada tenant activo, y la transición
 * `snoozed → open|new` no tiene nada que validar que el `WHERE` no diga ya.
 * Lo que sí hace falta es el evento, y se publica sobre las filas que el
 * UPDATE devuelve: uno por conversación despertada, en esta misma
 * transacción, con el mismo nombre y la misma forma de payload que publica
 * `changeConversationState`. Un evento con dos formas según quién lo emite es
 * un evento en el que no se puede confiar.
 */
async function despertarPospuestas(
  client: PoolClient,
  tenantId: string,
  now: Date,
): Promise<string[]> {
  const r = await client.query(
    `UPDATE conversations
        SET state = CASE WHEN owner_id IS NULL THEN 'new' ELSE 'open' END,
            snoozed_until = NULL,
            updated_at = now()
      WHERE tenant_id = $1 AND state = 'snoozed'
        AND snoozed_until IS NOT NULL AND snoozed_until <= $2::timestamptz
      RETURNING id, owner_id, state`,
    [tenantId, now],
  );
  for (const fila of r.rows) {
    await publishEvent(client, {
      name: 'conversation.state_changed',
      tenantId,
      payload: { conversationId: fila.id, from: 'snoozed', to: fila.state },
      actor: 'system',
    });
  }
  return r.rows.map((fila) => fila.id as string);
}
