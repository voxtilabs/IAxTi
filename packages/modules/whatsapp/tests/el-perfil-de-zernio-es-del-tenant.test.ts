import { afterEach, describe, expect, it } from 'vitest';
import {
  cuentaDelPerfil,
  cuentaEnZernio,
  enlaceParaConectar,
  ErrorDelAlta,
  eventoDeZernioEsDeLaCuenta,
  llaveDelTenant,
  perfilDelTenant,
  suscribirWebhook,
} from '../application/zernio-perfil';
import type { ConfigDeZernio } from '../application/zernio-base';

/**
 * Un perfil de Zernio por tenant, y que el código no pueda cruzarlos (#1321).
 *
 * Lo que se protege acá: que el mensaje del cliente de un negocio no entre en
 * la bandeja de otro, y que una cuenta conectada en el perfil de un negocio no
 * quede dada de alta en otro. Se mide POR EL PUERTO (#870): `fetch`
 * interceptado, mirando la petición HTTP de verdad, sin red ni llave real.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const cuentaA = {
  tenantId: TENANT_A,
  config: { zernioAccountId: 'acc_A', zernioProfileId: 'prof_A' },
};

/** Un `message.received` con la forma del spec v1.615. */
function evento(over: { accountId?: string; profileId?: string; perfiles?: Array<{ id?: string; externalId?: string | null }>; test?: boolean } = {}) {
  return {
    id: 'evt_1',
    event: 'message.received',
    ...(over.test ? { test: true } : {}),
    profiles: over.perfiles ?? [{ id: 'prof_A', externalId: TENANT_A }],
    account: { id: over.accountId ?? 'acc_A', accountId: over.accountId ?? 'acc_A', profileId: over.profileId ?? 'prof_A', platform: 'whatsapp' },
    message: { id: 'm1', conversationId: 'conv1', direction: 'incoming', text: 'hola', sender: { phoneNumber: '+56911112222' } },
  };
}

describe('el evento es de la cuenta y del negocio', () => {
  it('el de su cuenta, su perfil y su tenant entra', () => {
    expect(eventoDeZernioEsDeLaCuenta(evento(), cuentaA)).toEqual({ ok: true });
  });

  it.each([
    ['de otra cuenta de Zernio', evento({ accountId: 'acc_B' })],
    ['de una cuenta que se movió a otro perfil', evento({ profileId: 'prof_B' })],
    ['de un perfil cuyo externalId es otro negocio', evento({ perfiles: [{ id: 'prof_A', externalId: TENANT_B }] })],
    ['de un perfil sin externalId', evento({ perfiles: [{ id: 'prof_A', externalId: null }] })],
    ['que no dice de qué perfil es', evento({ perfiles: [] })],
    ['que también es de otro negocio', evento({ perfiles: [{ id: 'prof_A', externalId: TENANT_A }, { id: 'prof_B', externalId: TENANT_B }] })],
    ['que nombra el tenant pero en otro perfil', evento({ perfiles: [{ id: 'prof_X', externalId: TENANT_A }] })],
  ])('el %s NO entra, aunque la firma calce', (_n, payload) => {
    const v = eventoDeZernioEsDeLaCuenta(payload, cuentaA);
    expect(v.ok).toBe(false);
    expect(v).not.toHaveProperty('prueba', true);
  });

  it('sin la cuenta y el perfil guardados no entra nada: falla cerrado', () => {
    expect(eventoDeZernioEsDeLaCuenta(evento(), { tenantId: TENANT_A, config: {} }).ok).toBe(false);
    expect(eventoDeZernioEsDeLaCuenta(evento(), { tenantId: TENANT_A, config: { zernioAccountId: 'acc_A' } }).ok).toBe(false);
  });

  it('un sobre sin `account` o que no es objeto no entra', () => {
    const sinCuenta: Record<string, unknown> = evento();
    delete sinCuenta.account;
    expect(eventoDeZernioEsDeLaCuenta(sinCuenta, cuentaA).ok).toBe(false);
    expect(eventoDeZernioEsDeLaCuenta(null, cuentaA).ok).toBe(false);
    expect(eventoDeZernioEsDeLaCuenta('x', cuentaA).ok).toBe(false);
  });

  it('la muestra de `POST /v1/webhooks/test` se reconoce como prueba, no como mensaje', () => {
    expect(eventoDeZernioEsDeLaCuenta(evento({ test: true, accountId: 'inventada' }), cuentaA)).toEqual({ ok: false, prueba: true });
  });
});

// --- El alta contra Zernio -------------------------------------------------

interface Peticion {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}
let peticiones: Peticion[] = [];

type Respuesta = { status?: number; body: unknown };
/** Responde por método + ruta (sin query). Lo que no está previsto, 500: que se note. */
function zernio(rutas: Record<string, Respuesta | ((p: Peticion) => Respuesta)>): ConfigDeZernio {
  peticiones = [];
  const fetchImpl = (async (entrada: unknown, init?: RequestInit) => {
    const url = String(entrada);
    const p: Peticion = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
    peticiones.push(p);
    const ruta = new URL(url).pathname.replace(/^\/api/, '');
    const r = rutas[`${p.method} ${ruta}`];
    const res = typeof r === 'function' ? r(p) : r;
    if (!res) return new Response(JSON.stringify({ error: 'no previsto' }), { status: 500 });
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  }) as typeof fetch;
  return { apiKey: 'sk_operador', apiBase: 'https://zernio.test/api', fetchImpl };
}

afterEach(() => {
  peticiones = [];
});

describe('el perfil del tenant', () => {
  it('si ya existe se usa, y no se crea otro', async () => {
    const cfg = zernio({ 'GET /v1/profiles': { body: { profiles: [{ _id: 'prof_A', name: 'A', externalId: TENANT_A }] } } });
    const r = await perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'Ferretería' });
    expect(r).toEqual({ perfil: { _id: 'prof_A', name: 'A', externalId: TENANT_A }, creado: false });
    expect(peticiones.map((p) => p.method)).toEqual(['GET']);
    expect(new URL(peticiones[0]!.url).searchParams.get('externalId')).toBe(TENANT_A);
  });

  it('si no existe se crea con externalId = tenant y una llave de idempotencia del tenant', async () => {
    const cfg = zernio({
      'GET /v1/profiles': { body: { profiles: [] } },
      'POST /v1/profiles': (p) => ({ status: 201, body: { profile: { _id: 'prof_nuevo', name: p.body!.name, externalId: p.body!.externalId } } }),
    });
    const r = await perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'Ferretería' });
    expect(r.creado).toBe(true);
    const post = peticiones.find((p) => p.method === 'POST')!;
    expect(post.body).toMatchObject({ externalId: TENANT_A, name: `Ferretería · ${TENANT_A.slice(0, 8)}` });
    expect(post.headers['idempotency-key']).toBe(`iaxti-perfil-${TENANT_A}`);
  });

  it('dos altas a la vez: la segunda choca con 409 y toma el perfil de la primera', async () => {
    let creado = false;
    const cfg = zernio({
      'GET /v1/profiles': () => ({ body: { profiles: creado ? [{ _id: 'prof_A', name: 'A', externalId: TENANT_A }] : [] } }),
      'POST /v1/profiles': () => {
        creado = true; // la otra alta ganó entre el GET y el POST
        return { status: 409, body: { code: 'profile_external_id_conflict' } };
      },
    });
    const r = await perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'Ferretería' });
    expect(r).toEqual({ perfil: { _id: 'prof_A', name: 'A', externalId: TENANT_A }, creado: false });
  });

  it('si Zernio ignora el filtro y devuelve perfiles de otros, no se toma ninguno ajeno', async () => {
    const cfg = zernio({
      'GET /v1/profiles': { body: { profiles: [{ _id: 'prof_B', name: 'B', externalId: TENANT_B }] } },
      'POST /v1/profiles': { status: 201, body: { profile: { _id: 'prof_A', name: 'A', externalId: TENANT_A } } },
    });
    const r = await perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'Ferretería' });
    expect(r.perfil._id).toBe('prof_A');
  });

  it('dos perfiles con el mismo externalId: no se adivina, se para', async () => {
    const cfg = zernio({
      'GET /v1/profiles': { body: { profiles: [{ _id: 'p1', name: 'x', externalId: TENANT_A }, { _id: 'p2', name: 'y', externalId: TENANT_A }] } },
    });
    await expect(perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'F' })).rejects.toBeInstanceOf(ErrorDelAlta);
  });

  it('409 por nombre de otro negocio: se para, no se toma ese perfil', async () => {
    const cfg = zernio({
      'GET /v1/profiles': { body: { profiles: [] } },
      'POST /v1/profiles': { status: 409, body: { code: 'profile_name_conflict' } },
    });
    await expect(perfilDelTenant(cfg, { tenantId: TENANT_A, nombre: 'F' })).rejects.toThrow(/nombre/);
  });
});

describe('la cuenta que se da de alta es del perfil del tenant', () => {
  it('una cuenta del perfil, de la plataforma pedida, pasa', async () => {
    const cfg = zernio({ 'GET /v1/accounts': { body: { accounts: [{ _id: 'acc_A', platform: 'whatsapp', profileId: 'prof_A' }] } } });
    const c = await cuentaDelPerfil(cfg, { profileId: 'prof_A', zernioAccountId: 'acc_A', plataforma: 'whatsapp' });
    expect(c._id).toBe('acc_A');
  });

  it('el cruce a propósito: la cuenta de OTRO perfil no se da de alta, aunque Zernio la devuelva', async () => {
    // Zernio ignorando `profileId` y devolviendo todo: la comprobación es nuestra.
    const cfg = zernio({
      'GET /v1/accounts': { body: { accounts: [{ _id: 'acc_B', platform: 'whatsapp', profileId: { _id: 'prof_B' } }] } },
    });
    await expect(
      cuentaDelPerfil(cfg, { profileId: 'prof_A', zernioAccountId: 'acc_B', plataforma: 'whatsapp' }),
    ).rejects.toThrow(/no está en el perfil de este negocio/);
  });

  it('una cuenta de Instagram no se da de alta como WhatsApp', async () => {
    const cfg = zernio({ 'GET /v1/accounts': { body: { accounts: [{ _id: 'acc_A', platform: 'instagram', profileId: 'prof_A' }] } } });
    await expect(
      cuentaDelPerfil(cfg, { profileId: 'prof_A', zernioAccountId: 'acc_A', plataforma: 'whatsapp' }),
    ).rejects.toThrow(/instagram/);
  });

  it('el diagnóstico: viva, a reconectar, borrada o sin poder preguntar', async () => {
    const viva = zernio({ 'GET /v1/accounts': { body: { accounts: [{ _id: 'acc_A', platform: 'whatsapp', profileId: 'prof_A', isActive: true }] } } });
    expect(await cuentaEnZernio(viva, { profileId: 'prof_A', zernioAccountId: 'acc_A' })).toEqual({ existe: true, canales: ['whatsapp'] });
    const vencida = zernio({ 'GET /v1/accounts': { body: { accounts: [{ _id: 'acc_A', platform: 'whatsapp', profileId: 'prof_A', needsReconnection: true }] } } });
    expect(await cuentaEnZernio(vencida, { profileId: 'prof_A', zernioAccountId: 'acc_A' })).toEqual({ existe: true, canales: [] });
    const borrada = zernio({ 'GET /v1/accounts': { body: { accounts: [] } } });
    expect(await cuentaEnZernio(borrada, { profileId: 'prof_A', zernioAccountId: 'acc_A' })).toEqual({ existe: false, canales: [] });
    const caida = zernio({});
    expect(await cuentaEnZernio(caida, { profileId: 'prof_A', zernioAccountId: 'acc_A' })).toBeNull();
  });
});

describe('la llave del negocio solo ve su perfil', () => {
  it('se pide restringida al perfil y sin webhooks, y se comprueba con ella misma', async () => {
    const cfg = zernio({
      // La forma REAL de la respuesta (medida 18-11): `profileIds` viene como
      // objetos `{_id}`. Con strings en el mock, la prueba daba verde mientras
      // el alta real borraba la llave sana.
      'POST /v1/api-keys': { status: 201, body: { apiKey: { id: 'k1', key: 'zrk_A', scope: 'profiles', profileIds: [{ _id: 'prof_A', name: 'A' }] } } },
      'GET /v1/profiles': { body: { profiles: [{ _id: 'prof_A', name: 'A', externalId: TENANT_A }] } },
    });
    expect(await llaveDelTenant(cfg, { tenantId: TENANT_A, profileId: 'prof_A' })).toEqual({ llave: 'zrk_A', id: 'k1' });
    const post = peticiones.find((p) => p.method === 'POST')!;
    expect(post.body).toMatchObject({ scope: 'profiles', profileIds: ['prof_A'] });
    expect(post.body!.disabledResourceGroups).toContain('webhooks');
    // La comprobación va con la llave NUEVA, no con la del operador.
    const comprobacion = peticiones.find((p) => p.method === 'GET')!;
    expect(comprobacion.headers.authorization).toBe('Bearer zrk_A');
  });

  it('si la llave ve otro perfil, se borra y no sale', async () => {
    const cfg = zernio({
      'POST /v1/api-keys': { status: 201, body: { apiKey: { id: 'k1', key: 'zrk_A', scope: 'profiles', profileIds: [{ _id: 'prof_A', name: 'A' }] } } },
      'GET /v1/profiles': { body: { profiles: [{ _id: 'prof_A' }, { _id: 'prof_B' }] } },
      'DELETE /v1/api-keys/k1': { body: { success: true } },
    });
    await expect(llaveDelTenant(cfg, { tenantId: TENANT_A, profileId: 'prof_A' })).rejects.toThrow(/Se borró/);
    expect(peticiones.some((p) => p.method === 'DELETE' && p.url.endsWith('/v1/api-keys/k1'))).toBe(true);
  });

  it('acepta también profileIds como strings: la forma la decide Zernio, no esta prueba', async () => {
    const cfg = zernio({
      'POST /v1/api-keys': { status: 201, body: { apiKey: { id: 'k1', key: 'zrk_A', scope: 'profiles', profileIds: ['prof_A'] } } },
      'GET /v1/profiles': { body: { profiles: [{ _id: 'prof_A', name: 'A', externalId: TENANT_A }] } },
    });
    expect(await llaveDelTenant(cfg, { tenantId: TENANT_A, profileId: 'prof_A' })).toEqual({ llave: 'zrk_A', id: 'k1' });
  });

  it('si Zernio la devuelve con alcance completo, se borra sin usarla', async () => {
    const cfg = zernio({
      'POST /v1/api-keys': { status: 201, body: { apiKey: { id: 'k1', key: 'sk_full', scope: 'full', profileIds: [] } } },
      'DELETE /v1/api-keys/k1': { body: { success: true } },
    });
    await expect(llaveDelTenant(cfg, { tenantId: TENANT_A, profileId: 'prof_A' })).rejects.toBeInstanceOf(ErrorDelAlta);
    expect(peticiones.some((p) => p.headers.authorization === 'Bearer sk_full')).toBe(false);
  });
});

describe('el webhook queda atado a su perfil y su cuenta', () => {
  it('se crea con profileIds, accountIds y un secreto nuevo', async () => {
    const cfg = zernio({
      'GET /v1/webhooks/settings': { body: { webhooks: [] } },
      'POST /v1/webhooks/settings': { body: { webhook: { _id: 'wh1', url: 'https://api.test/webhooks/channels/c1' } } },
    });
    const r = await suscribirWebhook(cfg, { url: 'https://api.test/webhooks/channels/c1', profileId: 'prof_A', zernioAccountId: 'acc_A' });
    expect(r.creado).toBe(true);
    expect(r.secreto).toMatch(/^[0-9a-f]{64}$/);
    const post = peticiones.find((p) => p.method === 'POST')!;
    expect(post.body).toMatchObject({ profileIds: ['prof_A'], accountIds: ['acc_A'], secret: r.secreto, events: ['message.received'] });
  });

  it('correr el alta otra vez actualiza el mismo webhook: no deja dos que dupliquen cada mensaje', async () => {
    const cfg = zernio({
      'GET /v1/webhooks/settings': { body: { webhooks: [{ _id: 'wh1', url: 'https://api.test/webhooks/channels/c1' }] } },
      'PUT /v1/webhooks/settings': { body: { success: true } },
    });
    const r = await suscribirWebhook(cfg, { url: 'https://api.test/webhooks/channels/c1', profileId: 'prof_A', zernioAccountId: 'acc_A' });
    expect(r).toMatchObject({ id: 'wh1', creado: false });
    expect(peticiones.map((p) => p.method)).toEqual(['GET', 'PUT']);
    expect(peticiones[1]!.body).toMatchObject({ webhookId: 'wh1', accountIds: ['acc_A'] });
  });
});

describe('el enlace de conexión', () => {
  it('abre la página alojada en español; con modo api y número fijado, la petición los pide', async () => {
    // El modo por omisión del popup es «coexistence»: la app WhatsApp
    // Business del teléfono compartiendo el número con la Cloud API. `api`
    // es el caso aparte —un número que SOLO vive en la Cloud API de otro
    // proveedor, sin la app encima— y el número fijado evita que se conecte
    // otro por error (spec v1.679, #1338). Número de prueba, no el de nadie.
    const cfg = zernio({ 'GET /v1/connect/whatsapp': { body: { authUrl: 'https://zernio.com/conectar' } } });
    const enlace = await enlaceParaConectar(cfg, {
      profileId: 'prof_A',
      modo: 'api',
      numeroEsperado: '+56911112222',
    });
    expect(enlace).toBe('https://zernio.com/conectar');
    const u = new URL(peticiones[0]!.url);
    expect(u.pathname).toBe('/api/v1/connect/whatsapp');
    expect(u.searchParams.get('profileId')).toBe('prof_A');
    expect(u.searchParams.get('signup')).toBe('hosted');
    expect(u.searchParams.get('language')).toBe('es');
    expect(u.searchParams.get('onboarding')).toBe('api');
    expect(u.searchParams.get('expectedPhoneNumber')).toBe('+56911112222');
  });

  it('sin modo ni número no manda nada extra: el defecto lo elige Zernio', async () => {
    const cfg = zernio({ 'GET /v1/connect/whatsapp': { body: { authUrl: 'https://zernio.com/conectar' } } });
    await enlaceParaConectar(cfg, { profileId: 'prof_A' });
    const u = new URL(peticiones[0]!.url);
    expect(u.searchParams.get('onboarding')).toBeNull();
    expect(u.searchParams.get('expectedPhoneNumber')).toBeNull();
  });
});

