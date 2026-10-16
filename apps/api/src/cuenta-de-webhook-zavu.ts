import type { PoolClient } from 'pg';
import { cuentaDelEmisor, emisorAcreditado, type ChannelAccountRef } from '@iaxti/module-channels';

/** El sobre solo puede elegir canal DESPUÉS de autenticarlo con la firma común. */
export async function cuentaDeWebhookZavu<T extends ChannelAccountRef>(client: PoolClient, primaria: T, payload: unknown): Promise<ChannelAccountRef | null> {
  if (!['whatsapp', 'instagram', 'messenger'].includes(primaria.kind)) return primaria;
  if (!payload || typeof payload !== 'object') return null;
  const sobre = payload as { senderId?: unknown; data?: { channel?: unknown } };
  const kind = sobre.data?.channel;
  // Sobres históricos sin canal explícito conservan su receptor. No sirven
  // para escoger otro canal; un sender explícito ajeno tampoco entra por ahí.
  if (kind === undefined) {
    return sobre.senderId === undefined || sobre.senderId === primaria.config.senderId ? primaria : null;
  }
  if (kind !== 'whatsapp' && kind !== 'instagram' && kind !== 'messenger') return null;
  if (typeof sobre.senderId !== 'string') return null;
  const cuenta = await cuentaDelEmisor(client, {
    tenantId: primaria.tenantId, webhookAccountId: primaria.id, senderId: sobre.senderId, kind,
  });
  if (cuenta) return cuenta;
  // Una reserva con receptor acreditado y sin destino inequívoco no cae en el
  // primario. El fallback conserva cuentas históricas sin receptor acreditado.
  if (await emisorAcreditado(client, primaria.tenantId, sobre.senderId)) return null;
  return kind === primaria.kind && sobre.senderId === primaria.config.senderId ? primaria : null;
}
