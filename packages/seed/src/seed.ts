import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { ModuleRegistry } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { baseRoleHasPermission } from '@iaxti/module-authorization';
import { upsertProfile } from '@iaxti/module-identity';
import { createTenant } from '@iaxti/module-organizations';

// Seed del tenant de prueba (issue #18, criterio de salida de la Fase 1):
// idempotente — correrlo dos veces no duplica nada.
export const TENANT_NAME = 'Demo IAxTi';
export const USERS = [
  { email: 'duena@demo-iaxti.cl', name: 'Dueña Demo', role: 'ADMIN' },
  { email: 'vendedor@demo-iaxti.cl', name: 'Vendedor Demo', role: 'USER' },
] as const;
const DEMO_PASSWORD = 'IAxTi-demo-2026!';

/** Sin Supabase configurado, el uuid es determinista por email (idempotencia). */
function stableUuid(email: string): string {
  const h = createHash('sha256').update(`iaxti-seed:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Crea (o encuentra) el usuario REAL en Supabase Auth con la Admin API. */
async function ensureSupabaseUser(email: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const create = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: DEMO_PASSWORD, email_confirm: true }),
  });
  if (create.ok) return ((await create.json()) as { id: string }).id;

  // Ya existe: buscarlo.
  const list = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, { headers });
  if (!list.ok) throw new Error(`Supabase admin users falló: ${list.status}`);
  const body = (await list.json()) as { users: Array<{ id: string; email: string }> };
  const found = body.users.find((u) => u.email === email);
  if (!found) throw new Error(`No se pudo crear ni encontrar al usuario ${email}`);
  return found.id;
}

async function ensureTenant(client: PoolClient): Promise<string> {
  const existing = await client.query('SELECT id FROM tenants WHERE name = $1', [TENANT_NAME]);
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0].id;
  const tenant = await createTenant(client, { name: TENANT_NAME, rubro: 'servicios' });
  return tenant.id;
}

export interface SeedResult {
  tenantId: string;
  users: Array<{ email: string; userId: string; role: string; loginReal: boolean }>;
}

export async function seed(pool: Pool): Promise<SeedResult> {
  await runMigrations(pool);

  const client = await pool.connect();
  let tenantId: string;
  try {
    tenantId = await ensureTenant(client);
  } finally {
    client.release();
  }

  const users: SeedResult['users'] = [];
  for (const user of USERS) {
    const supabaseId = await ensureSupabaseUser(user.email);
    const userId = supabaseId ?? stableUuid(user.email);

    await withTenant(pool, tenantId, async (c) => {
      await upsertProfile(c, { userId, name: user.name });
      const role = await c.query(
        'SELECT id FROM roles WHERE name = $1 AND tenant_id IS NULL AND base',
        [user.role],
      );
      await c.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
        [tenantId, userId, role.rows[0].id],
      );
      await writeAudit(c, {
        tenantId,
        actor: 'seed',
        actorKind: 'system',
        action: 'seed.user_ready',
        resource: 'user',
        resourceId: userId,
        result: 'ok',
        metadata: { email: user.email, role: user.role },
      });
    });
    users.push({ email: user.email, userId, role: user.role, loginReal: supabaseId !== null });
  }

  return { tenantId, users };
}

async function main() {
  const pool = createPool();
  try {
    const result = await seed(pool);
    const catalog = new Set(new ModuleRegistry().load().permissionsCatalog().keys());

    console.log(`Tenant "${TENANT_NAME}": ${result.tenantId}`);
    for (const u of result.users) {
      console.log(
        `- ${u.email} · rol ${u.role} · ${u.loginReal ? `login real (clave: ${DEMO_PASSWORD})` : 'sin Supabase: uuid determinista'}`,
      );
    }
    // El criterio de la fase: el ADMIN puede lo que el USER no.
    const adminPuede = baseRoleHasPermission('ADMIN', 'users.manage', catalog);
    const userPuede = baseRoleHasPermission('USER', 'users.manage', catalog);
    console.log(`users.manage → ADMIN: ${adminPuede} · USER: ${userPuede}`);
    if (!adminPuede || userPuede) throw new Error('Los paquetes de roles no separan ADMIN de USER');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
