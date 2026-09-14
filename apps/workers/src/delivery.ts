import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { updateDeliveryStatusByProviderId } from '@iaxti/module-conversations';
import { causaLegible, type DeliveryStatusUpdate } from '@iaxti/module-whatsapp';

// Estados de entrega del webhook (#43): sent → delivered → read visibles en
// el chat, failed con causa legible, y el costo de Meta cuando viene.

export interface DeliveryStatusJob {
  moduleId?: 'conversations';
  tenantId: string;
  statuses: DeliveryStatusUpdate[];
  requestId?: string;
}

export async function processDeliveryStatuses(
  pool: Pool,
  data: DeliveryStatusJob,
): Promise<{ applied: number }> {
  let applied = 0;
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
      if (res) applied++;
    }
  });
  return { applied };
}
