import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createLocalSecretStore, type GoogleSecretStore } from '@iaxti/google';
import { findAccountById, proveedorDe, registerProvider } from '@iaxti/module-channels';
import { createZernioProvider } from '../application/zernio';
import { ErrorDelAlta } from '../application/zernio-perfil';
import { credencialDeLaCuenta, resolveChannelWebhookSecret } from '../application/webhook-secret';
import {
  conectarNumeroDesdeLaApp,
  enlaceParaConectarDesdeLaApp,
  numerosParaConectar,
  type DependenciasDelAlta,
} from '../application/conectar-desde-la-app';

/**
 * Conectar WhatsApp desde la app (#1393): la llave del negocio va de Zernio a
 * la custodia cifrada, y la base solo guarda dónde está.
 *
 * Todo es real menos Zernio: la base con RLS, la custodia AES-256-GCM en un
 * directorio temporal. Zernio es un doble que registra cada llamada y entrega
 * llaves y secretos con forma de verdad, para poder buscarlos después donde
 * NO tienen que estar.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let otroTenant: string;
let directorio: string;
let custodia: GoogleSecretStore;

interface Llamada {
  metodo: string;
  ruta: string;
  llave: string;
  cuerpo: Record<string, unknown> | null;
}

/** Un Zernio de mentira con UN perfil por tenant y las cuentas que se le den. */
function zernioFalso(opciones: { cuentas: Array<{ _id: string; displayName: string }>; fallaWebhook?: boolean }) {
  const llamadas: Llamada[] = [];
  const perfiles = new Map<string, { _id: string; name: string; externalId: string }>();
  const llavesVivas = new Map<string, { key: string; profileId: string }>();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const metodo = init.method ?? 'GET';
    const llave = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const cuerpo = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    llamadas.push({ metodo, ruta: u.pathname, llave, cuerpo });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (u.pathname === '/v1/profiles' && metodo === 'GET') {
      // Con la llave restringida, solo su perfil.
      const restringida = [...llavesVivas.values()].find((k) => k.key === llave);
      if (restringida) return json({ profiles: [...perfiles.values()].filter((p) => p._id === restringida.profileId) });
      const ext = u.searchParams.get('externalId');
      return json({ profiles: [...perfiles.values()].filter((p) => !ext || p.externalId === ext) });
    }
    if (u.pathname === '/v1/profiles' && metodo === 'POST') {
      const p = { _id: `prof_${randomBytes(4).toString('hex')}`, name: String(cuerpo!.name), externalId: String(cuerpo!.externalId) };
      perfiles.set(p._id, p);
      return json({ profile: p });
    }
    if (u.pathname === '/v1/connect/whatsapp') return json({ authUrl: `https://zernio.test/connect?${u.searchParams}` });
    if (u.pathname === '/v1/accounts') {
      const profileId = u.searchParams.get('profileId')!;
      return json({ accounts: opciones.cuentas.map((c) => ({ ...c, platform: 'whatsapp', profileId })) });
    }
    if (u.pathname === '/v1/api-keys' && metodo === 'POST') {
      const id = `key_${randomBytes(4).toString('hex')}`;
      const key = `zrk_${randomBytes(32).toString('hex')}`;
      const profileId = (cuerpo!.profileIds as string[])[0]!;
      llavesVivas.set(id, { key, profileId });
      return json({ apiKey: { id, key, scope: 'profiles', profileIds: [{ _id: profileId }] } });
    }
    if (u.pathname.startsWith('/v1/api-keys/') && metodo === 'DELETE') {
      llavesVivas.delete(u.pathname.split('/').pop()!);
      return json({});
    }
    if (u.pathname === '/v1/webhooks/settings') {
      if (opciones.fallaWebhook) return json({ code: 'INTERNAL' }, 500);
      if (metodo === 'GET') return json({ webhooks: [] });
      return json({ webhook: { _id: `wh_${randomBytes(4).toString('hex')}` } });
    }
    return json({ code: 'NOT_FOUND' }, 404);
  }) as typeof fetch;
  return { fetchImpl, llamadas, llavesVivas, perfiles };
}

function dependencias(
  z: ReturnType<typeof zernioFalso>,
  ambiente = { produccion: true, enviosRealesDeclarados: false },
): DependenciasDelAlta {
  return {
    zernio: { apiKey: 'zrk_operador', apiBase: 'https://zernio.test', fetchImpl: z.fetchImpl },
    custodia,
    conTenant: (t, fn) => withTenant(admin, t, fn),
    baseUrlApi: 'https://api.iaxti.test/',
    ambiente,
  };
}

const conectar = (deps: DependenciasDelAlta, tenantId: string, cuenta: string) =>
  conectarNumeroDesdeLaApp(deps, { tenantId, cuenta, actor: 'usuario-1393', actorKind: 'user', requestId: 'req_1393' });

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  if (!proveedorDe({ kind: 'whatsapp', provider: 'zernio' })) registerProvider(createZernioProvider('whatsapp'));
  await admin.query(
    `INSERT INTO plan_limits (plan, whatsapp_numbers, conversations_month, ia_executions_month,
                              retention_months, api_requests_month, modules)
     VALUES ('conectar1393', 5, 1000, 100, 12, 10000, '[]'::jsonb)
     ON CONFLICT (plan) DO UPDATE SET whatsapp_numbers = 5`,
  );
  const crear = async (nombre: string) =>
    (await admin.query("INSERT INTO tenants (name, plan) VALUES ($1, 'conectar1393') RETURNING id", [nombre])).rows[0].id;
  tenant = await crear('peluqueria-1393');
  otroTenant = await crear('otro-1393');
});

beforeEach(async () => {
  directorio = await mkdtemp(join(tmpdir(), 'custodia-1393-'));
  custodia = createLocalSecretStore({ directorio, clave: randomBytes(32).toString('base64') });
  for (const t of [tenant, otroTenant]) {
    for (const tabla of ['whatsapp_numbers', 'channel_senders', 'channel_accounts']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  }
});

afterAll(async () => {
  for (const t of [tenant, otroTenant]) {
    for (const tabla of ['whatsapp_numbers', 'channel_senders', 'channel_accounts', 'audit_log', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]).catch(() => undefined);
    }
  }
  await rm(directorio, { recursive: true, force: true });
  await admin.end();
});

describe('conectar WhatsApp desde la app', () => {
  it('el número queda activo, y su llave vive en la custodia y en ningún otro lado', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: '+56 9 2201 3949' }] });
    const deps = dependencias(z);
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });

    const { account, renovada } = await conectar(deps, tenant, 'acc_1393_a');
    expect(renovada).toBe(false);
    expect(account.state).toBe('active');

    const [{ key: llave }] = [...z.llavesVivas.values()];
    const fila = (await admin.query('SELECT * FROM channel_accounts WHERE id = $1', [account.id])).rows[0];
    expect(fila.credential_ref).toMatch(/^cu:custodia-local\/secrets\/iaxti-canal-/);
    expect(fila.webhook_secret_ref).toMatch(/^cu:custodia-local\/secrets\/iaxti-canal-/);

    // La llave de verdad se lee por la referencia...
    const cuenta = (await withTenant(admin, tenant, (c) => findAccountById(c, account.id)))!;
    expect(await credencialDeLaCuenta(cuenta, custodia)).toBe(llave);
    // ...y el secreto del webhook es el que se le mandó a Zernio.
    const enviado = z.llamadas.find((l) => l.ruta === '/v1/webhooks/settings' && l.metodo === 'POST')!.cuerpo!;
    expect(await resolveChannelWebhookSecret(cuenta, custodia)).toBe(enviado.secret);
    expect(enviado.url).toBe(`https://api.iaxti.test/webhooks/channels/${account.id}`);

    // Lo que NO puede pasar: la llave o el secreto en la base.
    const enLaBase = await admin.query(
      `SELECT (SELECT count(*) FROM channel_accounts WHERE tenant_id = $1 AND row_to_json(channel_accounts)::text LIKE '%' || $2 || '%')
            + (SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND row_to_json(audit_log)::text LIKE '%' || $2 || '%')
            + (SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND row_to_json(audit_log)::text LIKE '%' || $3 || '%') AS n`,
      [tenant, llave, String(enviado.secret)],
    );
    expect(Number(enLaBase.rows[0].n)).toBe(0);

    // Y queda dicho quién lo hizo.
    const audit = await admin.query(
      `SELECT action, actor, actor_kind FROM audit_log WHERE tenant_id = $1 AND resource_id = $2`,
      [tenant, account.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['channel.zernio.connected', 'channel.secrets.stored']),
    );
    expect(audit.rows.every((r) => r.actor === 'usuario-1393' && r.actor_kind === 'user')).toBe(true);
  });

  it('una cuenta que no está en el perfil de ESTE negocio no se conecta', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    const deps = dependencias(z);
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });
    await expect(conectar(deps, tenant, 'acc_de_otro')).rejects.toBeInstanceOf(ErrorDelAlta);
    const n = await admin.query('SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    expect(n.rows[0].n).toBe(0);
    expect(z.llamadas.some((l) => l.ruta === '/v1/api-keys')).toBe(false);
  });

  it('fuera de producción, sin declarar envíos reales, no llama a Zernio', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    const deps = dependencias(z, { produccion: false, enviosRealesDeclarados: false });
    await expect(enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'x' })).rejects.toThrow(
      /ZERNIO_ENVIOS_REALES/,
    );
    await expect(conectar(deps, tenant, 'acc_1393_a')).rejects.toThrow(/ZERNIO_ENVIOS_REALES/);
    expect(z.llamadas).toHaveLength(0);
  });

  it('declarado fuera de producción, el canal queda marcado como de envíos reales', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    const deps = dependencias(z, { produccion: false, enviosRealesDeclarados: true });
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });
    const { account } = await conectar(deps, tenant, 'acc_1393_a');
    expect(account.config.enviosReales).toBe(true);
  });

  it('reconectar reusa el canal, cambia la llave y destruye la anterior de la custodia', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    const deps = dependencias(z);
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });
    const primera = await conectar(deps, tenant, 'acc_1393_a');
    const antes = (await admin.query('SELECT credential_ref FROM channel_accounts WHERE id = $1', [primera.account.id])).rows[0];

    const segunda = await conectar(deps, tenant, 'acc_1393_a');
    expect(segunda.account.id).toBe(primera.account.id);
    expect(segunda.renovada).toBe(true);
    const ahora = (await admin.query('SELECT credential_ref FROM channel_accounts WHERE id = $1', [primera.account.id])).rows[0];
    expect(ahora.credential_ref).not.toBe(antes.credential_ref);
    // En disco quedan solo los dos secretos vigentes: llave y webhook.
    expect(await readdir(directorio)).toHaveLength(2);
    const cuenta = (await withTenant(admin, tenant, (c) => findAccountById(c, primera.account.id)))!;
    expect(await credencialDeLaCuenta(cuenta, custodia)).toMatch(/^zrk_/);
  });

  it('si el alta se corta a mitad, el canal no queda activo y no deja secretos ni llaves vivas', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }], fallaWebhook: true });
    const deps = dependencias(z);
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });
    await expect(conectar(deps, tenant, 'acc_1393_a')).rejects.toThrow();
    const fila = (await admin.query('SELECT state, credential_ref FROM channel_accounts WHERE tenant_id = $1', [tenant])).rows[0];
    expect(fila.state).toBe('connecting');
    expect(fila.credential_ref).toBeNull();
    expect(await readdir(directorio)).toHaveLength(0);
    expect(z.llavesVivas.size).toBe(0);

    // Y se puede terminar: el número sigue ofrecido y conectarlo de nuevo
    // reusa el mismo canal y lo activa.
    expect(await numerosParaConectar(deps, { tenantId: tenant })).toEqual([
      expect.objectContaining({ cuenta: 'acc_1393_a', yaConectado: false }),
    ]);
    const sano = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    for (const p of z.perfiles.values()) sano.perfiles.set(p._id, p);
    const { account } = await conectar(dependencias(sano), tenant, 'acc_1393_a');
    expect(account.state).toBe('active');
    const n = await admin.query('SELECT count(*)::int AS n FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    expect(n.rows[0].n).toBe(1);
  });

  it('una referencia copiada a la cuenta de OTRO negocio no se resuelve', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    const deps = dependencias(z);
    await enlaceParaConectarDesdeLaApp(deps, { tenantId: tenant, nombreDelNegocio: 'Peluquería' });
    const { account } = await conectar(deps, tenant, 'acc_1393_a');
    const fila = (
      await admin.query('SELECT credential_ref, webhook_secret_ref FROM channel_accounts WHERE id = $1', [account.id])
    ).rows[0];
    const ref = fila.credential_ref as string;
    // La referencia buena sí se resuelve: sin esto, las de abajo podrían pasar en vacío.
    expect(await credencialDeLaCuenta({ tenantId: tenant, id: account.id, credentialRef: ref }, custodia)).toMatch(/^zrk_/);
    const ajena = { tenantId: otroTenant, id: '00000000-0000-4000-8000-000000001393', credentialRef: ref };
    expect(await credencialDeLaCuenta(ajena, custodia)).toBeUndefined();
    // Y en la misma cuenta, el secreto del webhook no sirve como llave.
    const cruzada = { tenantId: tenant, id: account.id, credentialRef: fila.webhook_secret_ref as string };
    expect(cruzada.credentialRef).toMatch(/^cu:/);
    expect(await credencialDeLaCuenta(cruzada, custodia)).toBeUndefined();
  });

  it('mirar los números no crea el perfil en Zernio', async () => {
    const z = zernioFalso({ cuentas: [{ _id: 'acc_1393_a', displayName: 'Peluquería' }] });
    expect(await numerosParaConectar(dependencias(z), { tenantId: tenant })).toEqual([]);
    expect(z.llamadas.some((l) => l.metodo !== 'GET')).toBe(false);
  });
});
