import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { Pool } from 'pg';
import { withAuthenticatedUser } from '@iaxti/db';
import { tenantsOf, upsertProfile, type Membership } from '@iaxti/module-identity';
import { createTenant, initialBusinessOf, recordInitialBusiness } from '@iaxti/module-organizations';
import { assignRole } from '@iaxti/module-authorization';
import { writeAudit } from '@iaxti/module-audit';

/** Composición del alta inicial (#56). userId solo viene del JWT verificado.
 * No acepta ids, roles ni plan del navegador. El contexto previo al tenant
 * solo permite leer las membresías propias (ADR-0008); el tenant que se crea
 * se fija antes del outbox, la membresía y la auditoría, en la misma tx.
 * El lock vive hasta COMMIT/ROLLBACK: doble clic y respuesta perdida no crean
 * dos negocios. Un usuario ya invitado vuelve a su negocio sin elevar su rol.
 */
export async function registerInitialBusiness(
  pool: Pool,
  input: { userId: string; displayName: string; name: string; description: string; vertical: string; requestId?: string },
): Promise<Membership> {
  return withAuthenticatedUser(pool, input.userId, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('onboarding.registration'), hashtext($1))", [input.userId]);
    const existing = await tenantsOf(client, input.userId);
    const initial = await initialBusinessOf(client, input.userId);
    if (initial) {
      const membership = existing.find((item) => item.tenantId === initial);
      if (membership) return membership;
      throw new ForbiddenException({ code: 'REGISTRATION_ACCESS_REMOVED', message: 'Ya registraste un negocio y tu acceso cambió. Pide una invitación a quien lo administra.' });
    }
    if (existing.length) return existing[0]!;
    const tenantId = randomUUID();
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const tenant = await createTenant(client, {
      id: tenantId, name: input.name, rubro: input.vertical, description: input.description,
    });
    await upsertProfile(client, { userId: input.userId, name: input.displayName });
    await assignRole(client, {
      tenantId, userId: input.userId, actor: input.userId, roleName: 'ADMIN',
      createIfMissing: true, requestId: input.requestId,
    });
    await writeAudit(client, {
      tenantId, actor: input.userId, actorKind: 'user', action: 'onboarding.register',
      resource: 'tenant', resourceId: tenantId, result: 'ok', requestId: input.requestId,
      metadata: { plan: tenant.plan, state: tenant.state },
    });
    await recordInitialBusiness(client, input.userId, tenantId);
    return { tenantId, tenantName: tenant.name, roleName: 'ADMIN' };
  });
}
