import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@iaxti/db';
import {
  conversacionParaIniciar,
  registrarSalienteDelCanal,
  updateDeliveryStatusByProviderId,
} from '@iaxti/module-conversations';
import { getChannelAccount } from '@iaxti/module-channels';
import { ensureContactByPhone } from '@iaxti/module-crm';
import {
  causaLegible,
  consultarMensajeDelCanal,
  type DeliveryStatusUpdate,
} from '@iaxti/module-whatsapp';

// Estados de entrega del webhook (#43): sent → delivered → read visibles en
// el chat, failed con causa legible, y el costo de Meta cuando viene.

export interface DeliveryStatusJob {
  moduleId?: 'conversations';
  tenantId: string;
  statuses: DeliveryStatusUpdate[];
  /**
   * El canal por el que llegó (#1265). Hace falta para dos cosas que antes no
   * se necesitaban: saber con qué credencial preguntarle a Zavu por un
   * mensaje desconocido, y a qué emisor pertenece el hilo que se importe.
   */
  channelAccountId?: string;
  requestId?: string;
}

export async function processDeliveryStatuses(
  pool: Pool,
  data: DeliveryStatusJob,
): Promise<{ applied: number; importados: number }> {
  let applied = 0;
  let importados = 0;
  await withTenant(pool, data.tenantId, async (client) => {
    for (const st of data.statuses ?? []) {
      const res = await updateDeliveryStatusByProviderId(client, {
        tenantId: data.tenantId,
        providerMessageId: st.providerMessageId,
        status: st.status,
        error: st.status === 'failed' ? causaLegible(st.errorCode, st.errorDetail) : undefined,
        cost: st.cost,
        requestId: data.requestId,
      });
      if (res.estado === 'aplicado') {
        applied++;
        continue;
      }
      if (res.estado !== 'desconocido' || !data.channelAccountId) continue;
      /**
       * Un id que no conocemos puede ser el eco de lo que el dueño mandó
       * desde su teléfono (#1265). Antes se descartaba en silencio y la
       * bandeja mostraba media conversación.
       *
       * Se consulta y se importa; si algo falla, se cuenta como saltado. Un
       * eco que no se pudo traer es un mensaje que falta, no un job que
       * revienta y reintenta cinco veces contra el proveedor.
       */
      importados += (await importarElEco(client, data, st.providerMessageId)) ? 1 : 0;
    }
  });
  return { applied, importados };
}

/**
 * Trae de Zavu un saliente que no mandamos nosotros y lo deja en la bandeja.
 *
 * Devuelve `false` y no lanza ante cualquier tropiezo: el mensaje falta, que
 * es malo, pero reventar el job haría que los estados que venían detrás en el
 * mismo lote tampoco se apliquen.
 */
async function importarElEco(
  client: PoolClient,
  data: DeliveryStatusJob,
  providerMessageId: string,
): Promise<boolean> {
  const cuenta = await getChannelAccount(client, data.tenantId, data.channelAccountId!);
  const apiKey = cuenta?.credentialRef ? process.env[cuenta.credentialRef] : undefined;
  if (!apiKey) return false;
  const mensaje = await consultarMensajeDelCanal(providerMessageId, {
    apiKey,
    avisar: (motivo) =>
      console.warn(`[${data.requestId}] eco del canal: ${motivo}`),
  });
  // Un entrante con id desconocido NO es un eco: es un entrante que el camino
  // de entrada todavía no guardó, y meterlo por acá lo duplicaría.
  if (!mensaje || mensaje.direction !== 'outbound' || !mensaje.to) return false;
  const { conversationId } = await conversacionParaIniciar(client, {
    tenantId: data.tenantId,
    // `ensureContactByPhone` y no una búsqueda: el dueño puede estar
    // escribiéndole a alguien que todavía no es contacto —justo lo que pasó
    // en la medición—, y en ese caso la ficha nace acá.
    contactId: (
      await ensureContactByPhone(client, {
        tenantId: data.tenantId,
        phone: mensaje.to,
        origin: 'whatsapp',
        ...(data.requestId ? { requestId: data.requestId } : {}),
      })
    ).contact.id,
    channel: mensaje.channel ?? 'whatsapp',
    channelAccountId: data.channelAccountId ?? null,
  });
  await registrarSalienteDelCanal(client, {
    tenantId: data.tenantId,
    conversationId,
    providerMessageId: mensaje.providerMessageId,
    deliveryStatus: mensaje.status ?? 'sent',
    type: mensaje.type as never,
    body: mensaje.text,
    channelAccountId: data.channelAccountId ?? null,
    meta: {
      wamid: mensaje.wamid,
      enviadoEl: mensaje.enviadoEl?.toISOString() ?? null,
    },
    ...(data.requestId ? { requestId: data.requestId } : {}),
  });
  return true;
}
