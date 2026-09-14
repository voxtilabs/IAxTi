import type { PoolClient } from 'pg';
import { getTenantSettings } from '@iaxti/module-organizations';
import { bandejaSettings } from '../domain/horario';
import type { AssignmentMode } from '../domain/horario';
import { assignConversation } from './conversations';

export interface AutoAssignResult {
  assignedTo: string | null;
  via: AssignmentMode;
}

const RAZONES: Record<AssignmentMode, string> = {
  manual: '',
  round_robin: 'turno rotativo del equipo',
  last_owner: 'atendió a este contacto la última vez',
  ia_horario: 'horario autónomo de la IA',
};

/**
 * Asignación automática al llegar una conversación nueva (SPEC §11, #38),
 * según el modo del tenant: manual (nada), round-robin (quien lleva más
 * tiempo sin recibir una), al último que atendió al contacto, o a la IA en
 * horario autónomo (queda preparada: se activa con agents en Fase 3).
 */
export async function autoAssignNew(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; requestId?: string },
): Promise<AutoAssignResult> {
  const settings = bandejaSettings(await getTenantSettings(client, input.tenantId));
  const via = settings.assignmentMode;
  if (via === 'manual' || via === 'ia_horario') return { assignedTo: null, via };

  const conv = await client.query(
    `SELECT owner_id, contact_id, state FROM conversations
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.conversationId],
  );
  if (conv.rowCount === 0) return { assignedTo: null, via };
  if (conv.rows[0].owner_id || conv.rows[0].state !== 'new') return { assignedTo: null, via };

  let elegido: string | null = null;
  if (via === 'last_owner') {
    const ultimo = await client.query(
      `SELECT owner_id FROM conversations
       WHERE tenant_id = $1 AND contact_id = $2 AND owner_id IS NOT NULL AND id <> $3
       ORDER BY updated_at DESC LIMIT 1`,
      [input.tenantId, conv.rows[0].contact_id, input.conversationId],
    );
    elegido = ultimo.rows[0]?.owner_id ?? null;
  }
  if (!elegido) {
    // Round-robin sin puntero: recibe quien lleva MÁS tiempo sin asignación
    // (assignments es el historial). Justo, sin estado extra y a prueba de
    // gente que entra o sale del equipo.
    const turno = await client.query(
      `SELECT ur.user_id
         FROM user_roles ur
         LEFT JOIN assignments a
           ON a.tenant_id = ur.tenant_id AND a.to_owner_id = ur.user_id
        WHERE ur.tenant_id = $1
        GROUP BY ur.user_id
        ORDER BY max(a.created_at) ASC NULLS FIRST, ur.user_id
        LIMIT 1`,
      [input.tenantId],
    );
    elegido = turno.rows[0]?.user_id ?? null;
  }
  if (!elegido) return { assignedTo: null, via };

  await assignConversation(client, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    toOwnerId: elegido,
    reason: RAZONES[via],
    actor: 'system',
    requestId: input.requestId,
  });
  await client.query(
    'UPDATE conversations SET assigned_via = $3 WHERE tenant_id = $1 AND id = $2',
    [input.tenantId, input.conversationId, via],
  );
  return { assignedTo: elegido, via };
}
