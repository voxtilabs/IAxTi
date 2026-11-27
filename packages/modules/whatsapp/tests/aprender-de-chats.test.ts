import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import {
  autorizarAprendizajeDeChats,
  estadoDelHistorial,
  retirarAutorizacionDeChats,
  ErrorDeHistorial,
} from '../application/aprender-de-chats';

/**
 * Autorizar la lectura de los chats (#1406, ADR-0039).
 *
 * Lo que importa de estas funciones no es el happy path: es que la puerta
 * cierre. Un número que no está en coexistencia no tiene historial, y
 * autorizarlo sería prometerle a la dueña algo que no puede pasar. Y el
 * estado que lee la pantalla tiene que salir de la llave del NEGOCIO — la
 * del operador no ve el inbox de nadie.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let otroTenant: string;

/** La llave del negocio, por variable de entorno, como las cuentas viejas. */
const LLAVE_DEL_NEGOCIO = 'zrk_negocio_1406';
const REF_DE_LA_LLAVE = 'ZERNIO_API_KEY_1406';

let cuentaCoexistencia: string;
let cuentaSoloIaxti: string;
let cuentaDeOtro: string;

/** Las llamadas que salieron a Zernio: ninguna tiene que salir de más. */
let llamadas: Array<{ ruta: string; llave: string }> = [];
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const u = new URL(String(url));
  llamadas.push({ ruta: u.pathname, llave: String((init?.headers as Record<string, string>)?.authorization ?? '') });
  if (u.pathname === '/v1/accounts/acc_z/health') {
    return new Response(JSON.stringify({ coexistenceHistorySync: { status: 'requested' } }), { status: 200 });
  }
  return new Response(JSON.stringify({}), { status: 200 });
}) as typeof fetch;

async function alta(
  tenantId: string,
  config: Record<string, unknown>,
  activar = true,
): Promise<string> {
  return withTenant(admin, tenantId, async (c) => {
    const cuenta = await createChannelAccount(c, {
      tenantId,
      kind: 'whatsapp',
      name: 'WhatsApp de prueba',
      credentialRef: REF_DE_LA_LLAVE,
      config,
    });
    if (activar) await setChannelState(c, { tenantId, accountId: cuenta.id, state: 'active' });
    return cuenta.id;
  });
}

const ENCOLADO: Array<{ autorizadoEl: string }> = [];
const encolar = async (marca: { autorizadoEl: string }) => {
  ENCOLADO.push(marca);
};

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  process.env[REF_DE_LA_LLAVE] = LLAVE_DEL_NEGOCIO;
  const crear = async (nombre: string) =>
    (await admin.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [nombre])).rows[0].id;
  tenant = await crear('aprender-1406');
  otroTenant = await crear('aprender-1406-otro');
});

beforeEach(async () => {
  llamadas = [];
  ENCOLADO.length = 0;
  for (const t of [tenant, otroTenant]) {
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [t]).catch(() => undefined);
  }
  cuentaCoexistencia = await alta(tenant, {
    zernioAccountId: 'acc_z',
    zernioProfileId: 'prof_z',
    coexistencia: true,
  });
  cuentaSoloIaxti = await alta(tenant, { zernioAccountId: 'acc_api', zernioProfileId: 'prof_z' });
  cuentaDeOtro = await alta(otroTenant, { zernioAccountId: 'acc_otro', coexistencia: true });
});

afterAll(async () => {
  for (const t of [tenant, otroTenant]) {
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM audit_log WHERE tenant_id = $1', [t]).catch(() => undefined);
  }
  delete process.env[REF_DE_LA_LLAVE];
  await admin.end();
});

describe('autorizarAprendizajeDeChats', () => {
  it('marca la cuenta y deja el job en camino, con la auditoría de quién lo hizo', async () => {
    await withTenant(admin, tenant, (c) =>
      autorizarAprendizajeDeChats(c, {
        tenantId: tenant,
        accountId: cuentaCoexistencia,
        actor: 'duenia-1406',
        actorKind: 'user',
        requestId: 'req_1406',
        encolar,
      }),
    );
    const fila = (
      await admin.query(`SELECT config->'historial' AS historial FROM channel_accounts WHERE id = $1`, [
        cuentaCoexistencia,
      ])
    ).rows[0];
    expect(fila.historial.estado).toBe('esperando');
    expect(fila.historial.autorizadoPor).toBe('duenia-1406');
    // El job se encola UNA vez, con el instante de la autorización.
    expect(ENCOLADO).toHaveLength(1);
    expect(ENCOLADO[0].autorizadoEl).toBe(fila.historial.autorizadoEl);

    const audit = await admin.query(
      'SELECT action, actor, actor_kind FROM audit_log WHERE tenant_id = $1 AND resource_id = $2',
      [tenant, cuentaCoexistencia],
    );
    expect(audit.rows.map((r) => r.action)).toContain('whatsapp.historial.autorizado');
    expect(audit.rows[0].actor).toBe('duenia-1406');
  });

  it('un número que no está en coexistencia no se autoriza: no hay historial que leer', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        autorizarAprendizajeDeChats(c, {
          tenantId: tenant,
          accountId: cuentaSoloIaxti,
          actor: 'duenia-1406',
          actorKind: 'user',
          encolar,
        }),
      ),
    ).rejects.toThrow('Este número no está conectado en coexistencia: no hay historial que leer.');
    // Nada quedó: ni marca, ni auditoría, ni job.
    expect(ENCOLADO).toHaveLength(0);
    const fila = (
      await admin.query(`SELECT config->'historial' AS historial FROM channel_accounts WHERE id = $1`, [
        cuentaSoloIaxti,
      ])
    ).rows[0];
    expect(fila.historial).toBeNull();
    // Solo la auditoría del historial: el alta de la cuenta en la preparación
    // ya dejó la suya, y esa no es de esta prueba.
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 AND action LIKE 'whatsapp.historial.%'`,
      [tenant, cuentaSoloIaxti],
    );
    expect(audit.rows[0].n).toBe(0);
  });

  it('la cuenta de otro negocio no existe para este tenant', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        autorizarAprendizajeDeChats(c, {
          tenantId: tenant,
          accountId: cuentaDeOtro,
          actor: 'duenia-1406',
          actorKind: 'user',
          encolar,
        }),
      ),
    ).rejects.toThrow('No encontramos ese canal.');
  });

  it('una cuenta que no está activa se rechaza antes de tocar nada', async () => {
    const conectando = await alta(tenant, { zernioAccountId: 'acc_c', coexistencia: true }, false);
    await expect(
      withTenant(admin, tenant, (c) =>
        autorizarAprendizajeDeChats(c, {
          tenantId: tenant,
          accountId: conectando,
          actor: 'duenia-1406',
          actorKind: 'user',
          encolar,
        }),
      ),
    ).rejects.toThrow(ErrorDeHistorial);
  });
});

describe('retirarAutorizacionDeChats', () => {
  it('quita la marca y deja en la auditoría que había una', async () => {
    await withTenant(admin, tenant, (c) =>
      autorizarAprendizajeDeChats(c, {
        tenantId: tenant,
        accountId: cuentaCoexistencia,
        actor: 'duenia-1406',
        actorKind: 'user',
        encolar,
      }),
    );
    await withTenant(admin, tenant, (c) =>
      retirarAutorizacionDeChats(c, {
        tenantId: tenant,
        accountId: cuentaCoexistencia,
        actor: 'duenia-1406',
        actorKind: 'user',
        requestId: 'req_1406',
      }),
    );
    const fila = (
      await admin.query(`SELECT config->'historial' AS historial FROM channel_accounts WHERE id = $1`, [
        cuentaCoexistencia,
      ])
    ).rows[0];
    expect(fila.historial).toBeNull();
    const audit = await admin.query(
      'SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY id',
      [tenant, cuentaCoexistencia],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'whatsapp.historial.autorizado',
      'whatsapp.historial.retirado',
    ]);
    expect(audit.rows[1].metadata.tenia).toBe(true);
  });

  it('retirar lo que no estaba es idempotente, y lo dice la auditoría', async () => {
    await withTenant(admin, tenant, (c) =>
      retirarAutorizacionDeChats(c, {
        tenantId: tenant,
        accountId: cuentaCoexistencia,
        actor: 'duenia-1406',
        actorKind: 'user',
      }),
    );
    const audit = await admin.query(
      'SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2',
      [tenant, cuentaCoexistencia],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.tenia).toBe(false);
  });
});

describe('estadoDelHistorial', () => {
  it('un número sin coexistencia no le pregunta nada a Zernio', async () => {
    const estado = await withTenant(admin, tenant, (c) =>
      estadoDelHistorial(c, {
        tenantId: tenant,
        accountId: cuentaSoloIaxti,
        zernio: { apiBase: 'https://zernio.test', fetchImpl },
      }),
    );
    expect(estado).toEqual({ coexistencia: false, historial: null, deMeta: null });
    expect(llamadas).toHaveLength(0);
  });

  it('a Zernio se le pregunta con la llave del NEGOCIO, nunca la del operador', async () => {
    const estado = await withTenant(admin, tenant, (c) =>
      estadoDelHistorial(c, {
        tenantId: tenant,
        accountId: cuentaCoexistencia,
        zernio: { apiBase: 'https://zernio.test', fetchImpl },
      }),
    );
    expect(estado.coexistencia).toBe(true);
    expect(estado.deMeta).toBe('requested');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].ruta).toBe('/v1/accounts/acc_z/health');
    expect(llamadas[0].llave).toBe(`Bearer ${LLAVE_DEL_NEGOCIO}`);
  });

  // La base de pruebas local conecta como superusuario y RLS no se evalúa:
  // lo que se prueba es la comparación EXPLÍCITA del negocio en el caso de
  // uso, que es la que sostiene esto aunque RLS no estuviera.
  it('la cuenta de OTRO negocio no se autoriza ni se consulta', async () => {
    await expect(
      withTenant(admin, tenant, (c) =>
        autorizarAprendizajeDeChats(c, { tenantId: tenant, accountId: cuentaDeOtro, actor: 'duenia-1406', actorKind: 'user', encolar }),
      ),
    ).rejects.toThrow();
    expect(ENCOLADO).toHaveLength(0);
    const fila = (await admin.query(`SELECT config->'historial' AS historial FROM channel_accounts WHERE id = $1`, [cuentaDeOtro])).rows[0];
    expect(fila.historial).toBeNull();
  });
});
