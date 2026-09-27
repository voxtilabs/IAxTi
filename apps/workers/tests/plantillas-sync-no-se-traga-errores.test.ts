import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createTemplate, createZavuProvider, marcarEnviadaARevision } from '@iaxti/module-whatsapp';
import { getProvider, registerProvider } from '@iaxti/module-channels';
import { sincronizarPlantillas } from '../src/plantillas-sync';

/**
 * El barrido no se traga los errores del proveedor (#44).
 *
 * Zavu contesta el `POST /templates/sync` con 200 y un `errors` por cuenta: un
 * token de WABA vencido no es un 4xx, es un 200 con el error adentro. El
 * barrido descartaba ese retorno, seguía leyendo la copia vieja del proveedor
 * y no cambiaba nada — o sea que Meta aprobaba la plantilla, acá se quedaba
 * «en revisión» para siempre y nadie se enteraba. Exactamente lo que este
 * barrido existe para evitar, fallando en silencio.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const fetchReal = globalThis.fetch;

if (!getProvider('whatsapp')) registerProvider(createZavuProvider('whatsapp'));

/** Zavu con una cuenta caída: 200, pero con `errors` adentro. */
function zavuConCuentaCaida() {
  globalThis.fetch = (async (url: string) => {
    const cuerpo = String(url).includes('/templates/sync')
      ? {
          accountsSynced: 0,
          imported: 0,
          linked: 0,
          updated: 0,
          skipped: 1,
          errors: [{ senderId: 'snd_errores', error: 'whatsapp_token_expired' }],
        }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => cuerpo } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query(
    "INSERT INTO tenants (name) VALUES ('plantillas-sync-errores') RETURNING id",
  );
  tenant = t.rows[0].id;
  await admin.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, state, credential_ref, webhook_secret_ref, config)
     VALUES ($1, 'whatsapp', 'numero', 'active', 'ZAVU_KEY_ERRORES', 'ZAVU_SECRET_ERRORES', '{"senderId":"snd_errores"}'::jsonb)`,
    [tenant],
  );
  process.env.ZAVU_KEY_ERRORES = 'zv_test_errores';

  const p = await withTenant(admin, tenant, (c) =>
    createTemplate(c, {
      tenantId: tenant,
      name: 'colgada_con_token_vencido',
      language: 'es',
      category: 'utility',
      body: 'Hola {{1}}, te recordamos tu hora del {{2}}.',
    }),
  );
  await withTenant(admin, tenant, (c) =>
    marcarEnviadaARevision(c, { tenantId: tenant, templateId: p.id, providerId: 'tpl_prov' }),
  );
  // Las migraciones y el fixture van contra la base compartida de desarrollo:
  // los 10 s por defecto no alcanzan cuando hay otra suite encima.
}, 180_000);

afterEach(() => {
  globalThis.fetch = fetchReal;
  vi.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.ZAVU_KEY_ERRORES;
  for (const tabla of ['outbox', 'whatsapp_templates', 'channel_accounts']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('un 200 con errors no es un barrido exitoso', () => {
  // El barrido abre una transacción POR TENANT, y la base de desarrollo es
  // compartida: con un par de miles de tenants acumulados una pasada se va
  // bastante más allá de los 5 s por defecto. El tope generoso es del entorno,
  // no de lo que se está probando.
  it('lo cuenta y lo deja gritado en el log, con el tenant y qué revisar', { timeout: 180_000 }, async () => {
    zavuConCuentaCaida();
    const grito = vi.spyOn(console, 'error').mockImplementation(() => {});

    const r = await sincronizarPlantillas(admin);

    // Lo que importa: que alguien pueda enterarse. Una línea por el tenant
    // afectada, con el error del proveedor y qué revisar.
    const nuestro = grito.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((linea) => linea.includes(tenant));
    expect(nuestro).toHaveLength(1);
    expect(nuestro[0]).toContain('whatsapp_token_expired');
    expect(nuestro[0]).toMatch(/revisa la credencial/i);

    // Y el barrido no se corta —otras cuentas pueden traer novedades— pero
    // deja de decir que todo salió bien.
    expect(r.conErrores).toBeGreaterThanOrEqual(1);
  });
});
