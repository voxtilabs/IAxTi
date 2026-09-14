import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { applyQualityUpdate, type QualityUpdate } from '@iaxti/module-whatsapp';

/** Cambios de calidad del webhook de Meta (#45), por tenant. */
export interface QualityUpdateJob {
  moduleId?: 'whatsapp';
  tenantId: string;
  updates: QualityUpdate[];
  requestId?: string;
}

export async function processQualityUpdates(
  pool: Pool,
  data: QualityUpdateJob,
): Promise<{ applied: number }> {
  let applied = 0;
  await withTenant(pool, data.tenantId, async (client) => {
    for (const update of data.updates ?? []) {
      const res = await applyQualityUpdate(client, {
        tenantId: data.tenantId,
        update,
        requestId: data.requestId,
      });
      if (res.changed) applied++;
    }
  });
  return { applied };
}
