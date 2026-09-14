import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings, minutosHabilesEntre } from '../domain/horario';

export interface AlertSweepResult {
  unattended: string[];
  breached: string[];
}

/**
 * El barrido del job programado (#38, cada minuto por tenant activo):
 * (1) `new` sin dueño por más de N minutos → `conversation.unattended`
 *     (el aviso al supervisor; notifications lo convierte en campana en F3);
 * (2) sin primera respuesta tras el SLA en MINUTOS HÁBILES →
 *     `sla.first_response_breached`. Ambos una sola vez por conversación.
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
  return { unattended: sinDueno.rows.map((r) => r.id), breached };
}
