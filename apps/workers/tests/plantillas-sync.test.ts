import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createTemplate, createZavuProvider, getTemplate, marcarEnviadaARevision } from '@iaxti/module-whatsapp';
import { getProvider, registerProvider } from '@iaxti/module-channels';
import { sincronizarPlantillas } from '../src/plantillas-sync';

/**
 * El barrido que destraba plantillas colgadas (#44).
 *
 * El caso real: Meta aprueba, el webhook `template.status_changed` se pierde,
 * y la plantilla se queda "en revisión" para siempre. El negocio no puede
 * mandar nada fuera de la ventana de 24 h y nadie entiende por qué.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
const fetchReal = globalThis.fetch;

// El barrido pide las plantillas POR EL PUERTO del canal (#159), así que
// necesita el adaptador registrado — igual que en producción, donde lo
// registra el arranque del proceso. Hasta este cambio el proceso de workers
// no registraba ninguno y nadie lo notaba: el camino de salida llamaba al
// módulo whatsapp por su nombre.
if (!getProvider('whatsapp')) registerProvider(createZavuProvider('whatsapp'));

const base = {
  name: 'recordatorio_colgado',
  language: 'es',
  body: 'Hola {{1}}, te recordamos tu hora del {{2}}.',
  category: 'utility' as const,
};

/** Zavu de mentira: responde el sync y la lista de plantillas. */
function zavuDice(plantillas: Record<string, unknown>[]) {
  const rutas: string[] = [];
  globalThis.fetch = (async (url: string) => {
    rutas.push(String(url));
    const cuerpo = String(url).includes('/templates/sync')
      ? { accountsSynced: 1, imported: 0, linked: 0, updated: 1, skipped: 0, errors: [] }
      : { items: plantillas, nextCursor: null };
    return { ok: true, status: 200, json: async () => cuerpo } as unknown as Response;
  }) as unknown as typeof fetch;
  return rutas;
}

async function plantillaEnRevision(nombre: string): Promise<string> {
  const p = await withTenant(admin, tenant, (c) =>
    createTemplate(c, { tenantId: tenant, ...base, name: nombre }),
  );
  await withTenant(admin, tenant, (c) =>
    marcarEnviadaARevision(c, { tenantId: tenant, templateId: p.id, providerId: 'tpl_prov' }),
  );
  return p.id;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('plantillas-sync') RETURNING id");
  tenant = t.rows[0].id;
  await admin.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, state, credential_ref, webhook_secret_ref, config)
     VALUES ($1, 'whatsapp', 'numero', 'active', 'ZAVU_KEY_TEST', 'ZAVU_SECRET_TEST', '{"senderId":"snd_1"}'::jsonb)`,
    [tenant],
  );
  process.env.ZAVU_KEY_TEST = 'zv_test_abc';
});

afterEach(() => {
  globalThis.fetch = fetchReal;
});

afterAll(async () => {
  delete process.env.ZAVU_KEY_TEST;
  // `audit_log` no se borra: es append-only por trigger. Acá no se escribe
  // ninguna fila, así que el DELETE pasaba de largo sin que se notara.
  for (const tabla of ['outbox', 'whatsapp_templates', 'channel_accounts']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('reconciliación de plantillas', () => {
  it('una aprobada en Meta con el webhook perdido queda aprobada acá', async () => {
    const id = await plantillaEnRevision('aprobada_sin_aviso');
    const rutas = zavuDice([
      {
        id: 'tpl_meta_1',
        name: 'aprobada_sin_aviso',
        language: 'es',
        category: 'UTILITY',
        status: 'pending',
        whatsapp: { status: 'APPROVED' },
      },
    ]);

    const r = await sincronizarPlantillas(admin);
    expect(r.cambiadas).toBeGreaterThanOrEqual(1);
    // Primero le pide a Zavu que se ponga al día con Meta, después lee.
    expect(rutas[0]).toContain('/templates/sync');
    expect(rutas[1]).toContain('/templates?');

    const p = await withTenant(admin, tenant, (c) => getTemplate(c, tenant, id));
    expect(p.status).toBe('approved');
    expect(p.providerId).toBe('tpl_meta_1');
  });

  it('un rechazo llega con el motivo, no como "rechazada" a secas', async () => {
    const id = await plantillaEnRevision('rechazada_sin_aviso');
    zavuDice([
      {
        id: 'tpl_meta_2',
        name: 'rechazada_sin_aviso',
        language: 'es',
        category: 'UTILITY',
        status: 'pending',
        whatsapp: { status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' },
      },
    ]);

    await sincronizarPlantillas(admin);
    const p = await withTenant(admin, tenant, (c) => getTemplate(c, tenant, id));
    expect(p.status).toBe('rejected');
    expect(p.rejectionReason).toBe('INVALID_FORMAT');
  });

  it('la que sigue en revisión en Meta se queda en revisión: no se inventa', async () => {
    const id = await plantillaEnRevision('todavia_esperando');
    zavuDice([
      {
        id: 'tpl_meta_3',
        name: 'todavia_esperando',
        language: 'es',
        category: 'UTILITY',
        status: 'pending',
        whatsapp: { status: 'PENDING' },
      },
    ]);

    const r = await sincronizarPlantillas(admin);
    expect(r.cambiadas).toBe(0);
    const p = await withTenant(admin, tenant, (c) => getTemplate(c, tenant, id));
    expect(p.status).toBe('pending');
  });

  it('un estado que no entendemos no se traduce a nada', async () => {
    const id = await plantillaEnRevision('en_apelacion');
    zavuDice([
      {
        id: 'tpl_meta_4',
        name: 'en_apelacion',
        language: 'es',
        category: 'UTILITY',
        status: 'pending',
        whatsapp: { status: 'IN_APPEAL' },
      },
    ]);

    await sincronizarPlantillas(admin);
    const p = await withTenant(admin, tenant, (c) => getTemplate(c, tenant, id));
    expect(p.status).toBe('pending');
  });

  it('si el proveedor se cae, el barrido no se cae con él', async () => {
    const id = await plantillaEnRevision('con_proveedor_caido');
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(sincronizarPlantillas(admin)).resolves.toMatchObject({ cambiadas: 0 });
    const p = await withTenant(admin, tenant, (c) => getTemplate(c, tenant, id));
    expect(p.status).toBe('pending');
  });

  it('sin nada en revisión no se molesta al proveedor', async () => {
    await admin.query(
      `UPDATE whatsapp_templates SET status = 'approved' WHERE tenant_id = $1 AND status = 'pending'`,
      [tenant],
    );
    const rutas = zavuDice([]);
    const r = await sincronizarPlantillas(admin);
    expect(r.tenants).toBe(0);
    expect(rutas).toHaveLength(0);
  });
});
