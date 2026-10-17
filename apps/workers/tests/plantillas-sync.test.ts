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

/**
 * El número de ESTE caso, con un nombre que no se repite (#911).
 *
 * `sincronizarPlantillas` recorre TODOS los negocios que tengan algo en
 * revisión, así que lo que devuelve —`tenants`, `cambiadas`— habla de la base
 * entera, no de este tenant. En la base compartida de las pruebas eso vuelve
 * mentirosa cualquier afirmación sobre esos números: basta una plantilla
 * `pending` que otra corrida dejó atrás.
 *
 * La salida es preguntar por la tajada de este negocio. El `senderId` es lo
 * que permite reconocerla: viaja en el cuerpo del `POST /templates/sync`, que
 * es la PRIMERA llamada que el barrido hace por cada cuenta, así que si no
 * aparece, a este número no se lo molestó.
 */
const SENDER = `snd_911_${Math.random().toString(36).slice(2, 10)}`;

/**
 * El número de OTRO negocio, que sí tiene una plantilla esperando (#973).
 *
 * Es la otra mitad de «sin nada en revisión no se molesta a este número»: sin
 * un vecino que SÍ reciba llamadas, esa prueba también pasaría con el barrido
 * completamente roto, llamando a nadie. Con él, afirma las dos cosas que
 * importan: que al nuestro no se lo molesta y que el trabajo se sigue
 * haciendo. La idea es de #925.
 */
const SENDER_AJENO = `snd_911_ajeno_${Math.random().toString(36).slice(2, 10)}`;

let admin: Pool;
let tenant: string;
let tenantAjeno: string;
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

interface Llamada {
  url: string;
  /** El cuerpo tal cual salió: ahí viaja el `senderId` del POST. */
  cuerpo: string;
}

/** Zavu de mentira: responde el sync y la lista de plantillas. */
function zavuDice(plantillas: Record<string, unknown>[]) {
  const llamadas: Llamada[] = [];
  globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
    llamadas.push({ url: String(url), cuerpo: String(init?.body ?? '') });
    const cuerpo = String(url).includes('/templates/sync')
      ? { accountsSynced: 1, imported: 0, linked: 0, updated: 1, skipped: 0, errors: [] }
      : { items: plantillas, nextCursor: null };
    return { ok: true, status: 200, json: async () => cuerpo } as unknown as Response;
  }) as unknown as typeof fetch;
  return llamadas;
}

/**
 * El número al que fue cada llamada, venga donde venga (#973).
 *
 * Las dos formas del cliente de Zavu lo llevan, y en sitios distintos: el
 * `POST /templates/sync` en el cuerpo (`zavu-plantillas.ts:172`) y el
 * `GET /templates` en la query (`:204`). La primera versión de esto afirmaba
 * en un comentario que el GET NO lo llevaba, y reconocía sus llamadas por
 * venir detrás del sync. Era falso —basta leer la línea 204— y encima
 * frágil: el orden de dos negocios que se despachan seguidos no está
 * garantizado, así que «lo que vino después» podía incluir lo ajeno.
 *
 * Preguntar por el número es exacto y no depende del orden. La idea es de
 * #925, de Sebastian, que llegó a lo mismo por su cuenta.
 */
function numeroDeLaLlamada(l: Llamada): string | null {
  if (l.url.includes('/templates/sync')) {
    try {
      return (JSON.parse(l.cuerpo || '{}') as { senderId?: string }).senderId ?? null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(l.url).searchParams.get('senderId');
  } catch {
    return null;
  }
}

/** Lo que el barrido le pidió al proveedor por un número concreto. */
function porElNumero(llamadas: Llamada[], numero: string): string[] {
  return llamadas.filter((l) => numeroDeLaLlamada(l) === numero).map((l) => l.url);
}

/** Atajo para el número de este caso, que es el que más se usa. */
function porNuestroNumero(llamadas: Llamada[]): string[] {
  return porElNumero(llamadas, SENDER);
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
     VALUES ($1, 'whatsapp', 'numero', 'active', 'ZAVU_KEY_TEST', 'ZAVU_SECRET_TEST', $2::jsonb)`,
    [tenant, JSON.stringify({ senderId: SENDER })],
  );

  // El vecino: su propio número, su propia cuenta y una plantilla EN REVISIÓN
  // que no se toca en ningún caso. El barrido tiene que seguir visitándolo.
  tenantAjeno = (
    await admin.query("INSERT INTO tenants (name) VALUES ('plantillas-sync-vecino') RETURNING id")
  ).rows[0].id;
  await admin.query(
    `INSERT INTO channel_accounts (tenant_id, kind, name, state, credential_ref, webhook_secret_ref, config)
     VALUES ($1, 'whatsapp', 'numero', 'active', 'ZAVU_KEY_TEST', 'ZAVU_SECRET_TEST', $2::jsonb)`,
    [tenantAjeno, JSON.stringify({ senderId: SENDER_AJENO })],
  );
  await withTenant(admin, tenantAjeno, async (c) => {
    const p = await createTemplate(c, { tenantId: tenantAjeno, ...base, name: 'del_vecino' });
    await marcarEnviadaARevision(c, {
      tenantId: tenantAjeno,
      templateId: p.id,
      providerId: 'tpl_del_vecino',
    });
  });

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
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = ANY($1::uuid[])`, [
      [tenant, tenantAjeno],
    ]);
  }
  await admin.end();
});

describe('reconciliación de plantillas', () => {
  it('una aprobada en Meta con el webhook perdido queda aprobada acá', async () => {
    const id = await plantillaEnRevision('aprobada_sin_aviso');
    const llamadas = zavuDice([
      {
        id: 'tpl_meta_1',
        name: 'aprobada_sin_aviso',
        language: 'es',
        category: 'UTILITY',
        status: 'pending',
        whatsapp: { status: 'APPROVED' },
      },
    ]);

    await sincronizarPlantillas(admin);
    // Primero le pide a Zavu que se ponga al día con Meta, después lee.
    const nuestras = porNuestroNumero(llamadas);
    expect(nuestras[0]).toContain('/templates/sync');
    expect(nuestras[1]).toContain('/templates?');

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

    await sincronizarPlantillas(admin);
    // El `cambiadas` que devuelve el barrido es de TODA la base (#911): acá
    // lo que prueba que no se inventó nada es la fila de este negocio.
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

  it('sin nada en revisión no se molesta a ESTE número', async () => {
    await admin.query(
      `UPDATE whatsapp_templates SET status = 'approved' WHERE tenant_id = $1 AND status = 'pending'`,
      [tenant],
    );
    const llamadas = zavuDice([]);

    await sincronizarPlantillas(admin);

    // Antes acá decía `expect(r.tenants).toBe(0)`: que el barrido no hubiera
    // visitado a NADIE. Eso solo es cierto en una base virgen, y por eso la
    // prueba se ponía roja en local después de un día de corridas, por una
    // plantilla `pending` de otro negocio que no tiene nada que ver (#911).
    //
    // Lo que esta prueba viene a cazar es que a un negocio sin nada
    // esperando no se le pida nada al proveedor, y eso se pregunta por su
    // número.
    expect(porNuestroNumero(llamadas)).toHaveLength(0);
    // Y la otra mitad: este negocio no aparece en la lista de a quién hay que
    // visitar, que es de donde sale el trabajo.
    const aVisitar = await admin.query(
      'SELECT 1 FROM tenants_con_plantillas_en_revision() WHERE tenant_id = $1',
      [tenant],
    );
    expect(aVisitar.rowCount).toBe(0);
    // Y la tercera, que es la que vuelve honesta a las dos de arriba: al
    // VECINO, que sí tiene una plantilla esperando, se lo visitó igual. Sin
    // esto, un barrido que no llamara a nadie pasaría esta prueba (#973).
    expect(
      porElNumero(llamadas, SENDER_AJENO).map((u) => new URL(u).pathname),
    ).toEqual(['/v1/templates/sync', '/v1/templates']);
  });
});
