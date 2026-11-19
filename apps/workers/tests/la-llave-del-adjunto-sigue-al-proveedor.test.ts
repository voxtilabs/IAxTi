import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { createChannelAccount } from '@iaxti/module-channels';
import { processInbound, type InboundJob } from '../src/inbound';

/**
 * La llave que baja un adjunto solo viaja al dominio del proveedor (#1317,
 * #1335).
 *
 * `processInbound` le pasa a la descarga la base de Zernio —el único
 * transporte de WhatsApp que queda desde #1339— y `llevaCredencial` deja
 * viajar la llave solo a ese dominio o a un subdominio suyo. La URL sale del
 * payload del webhook: la firma prueba que el SOBRE es del proveedor, no que
 * cada URL de adentro apunte a él, así que la cerradura es por dominio.
 *
 * Entra por `processInbound` —el camino real del worker— con Postgres de
 * verdad y una cuenta de canal de verdad en la base; lo único falso es el
 * `fetch`, que se espía para leer la cabecera de la PETICIÓN que sale. Lo que
 * se cubre y lo que no:
 *
 *  · SÍ: la decisión de `inbound.ts` (que la descarga va con la base de
 *    Zernio) medida por el puerto, con las tres combinaciones que importan:
 *    el API del proveedor con llave, un subdominio suyo con llave, y un
 *    dominio ajeno SIN llave — el caso de la URL que alguien metió en el
 *    payload.
 *  · SÍ: que la llave que viaja es la de SU cuenta y no la de otra.
 *  · NO: `llevaCredencial` en sí —sus bordes (`startsWith`, `@`, `http:`) los
 *    prueba `la-llave-no-sale-del-proveedor.test.ts` en el módulo whatsapp.
 *  · NO: el envío SALIENTE ni la firma del webhook de Zernio —los prueba
 *    `el-adaptador-de-zernio.test.ts`.
 */

/** La base de pruebas del monorepo: NUNCA el 5432, que es de otro proyecto. */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5433/iaxti_pruebas';

const LLAVE_ZERNIO = 'LLAVE_DE_PRUEBA_1317_ZERNIO';
const LLAVE_OTRA = 'LLAVE_DE_PRUEBA_1317_OTRA_CUENTA';
const VALOR_ZERNIO = 'zr_llave_de_la_cuenta_de_zernio';
const VALOR_OTRA = 'zr_llave_de_otra_cuenta';

let admin: Pool;
let tenant: string;
let cuentaZernio: string;
let cuentaOtra: string;

/** Lo que salió por `fetch`: la URL y la cabecera de autorización, si viajó. */
interface Pedido {
  url: string;
  method: string;
  authorization: string | undefined;
}

let pedidos: Pedido[] = [];

/**
 * La cabecera puede llegar como objeto plano, `Headers` o ausente —la forma la
 * elige quien arma la petición, no esta prueba—, y el nombre es insensible a
 * mayúsculas.
 */
function autorizacionDe(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get('authorization') ?? undefined;
  if (Array.isArray(headers)) {
    for (const par of headers) {
      if (String(par[0]).toLowerCase() === 'authorization') return String(par[1]);
    }
    return undefined;
  }
  for (const [nombre, valor] of Object.entries(headers as Record<string, string>)) {
    if (nombre.toLowerCase() === 'authorization') return valor;
  }
  return undefined;
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('llave-adjunto-1317') RETURNING id");
  tenant = t.rows[0].id;
  // Las dos cuentas nacen con el por omisión de whatsapp: Zernio desde la
  // migración 0010 (#1339). Lo que las distingue es SU credencial, que es lo
  // que esta prueba espía.
  cuentaZernio = await withTenant(admin, tenant, async (client) => {
    const account = await createChannelAccount(client, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Cuenta de Zernio 1317',
      credentialRef: LLAVE_ZERNIO,
    });
    return account.id;
  });
  cuentaOtra = await withTenant(admin, tenant, async (client) => {
    const account = await createChannelAccount(client, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Otra cuenta de Zernio 1317',
      credentialRef: LLAVE_OTRA,
    });
    return account.id;
  });
  process.env[LLAVE_ZERNIO] = VALOR_ZERNIO;
  process.env[LLAVE_OTRA] = VALOR_OTRA;
  // R2 puesto: esta prueba mide la DESCARGA, y sin almacenamiento el camino se
  // salta entero y no sale ninguna petición que espiar.
  process.env.R2_ENDPOINT = 'https://cuenta-prueba.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'llave-de-prueba';
  process.env.R2_SECRET_ACCESS_KEY = 'secreto-de-prueba';
  process.env.R2_BUCKET_ADJUNTOS = 'adjuntos-prueba';
  // La base se fija a propósito y no se deja al ambiente: `llevaCredencial`
  // deriva el dominio de la cerradura de la base, y una ambiente con otra base
  // cambiaría qué hosts son «del proveedor» sin que esta prueba lo note.
  process.env.ZERNIO_API_BASE = 'https://zernio.com/api/v1';
}, 60_000);

beforeEach(() => {
  pedidos = [];
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    pedidos.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: autorizacionDe(init),
    });
    // La subida prefirmada a R2: solo hace falta que acepte.
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    // La descarga del adjunto: tres bytes alcanzan — el tope no es lo que se
    // mide acá, y búfers grandes ahogan el reportero de vitest (#1170).
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env[LLAVE_ZERNIO];
  delete process.env[LLAVE_OTRA];
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_ADJUNTOS;
  delete process.env.ZERNIO_API_BASE;
  if (tenant) {
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    // `audit_log` es append-only por trigger: sin `sinTriggers` esto revienta.
    await sinTriggers(admin, (c) =>
      c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]),
    );
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  }
  await admin?.end();
});

/** Un mensaje con un adjunto, por la cuenta que se diga. */
async function entraUnAdjunto(channelAccountId: string, url: string, phone: string): Promise<Pedido[]> {
  pedidos = [];
  await processInbound(admin, {
    moduleId: 'conversations',
    tenantId: tenant,
    phone,
    channel: 'whatsapp',
    channelAccountId,
    type: 'imagen',
    body: 'mira esto',
    attachments: [{ url, name: 'foto.jpg', contentType: 'image/jpeg' }],
  } as unknown as InboundJob);
  return pedidos;
}

/** La descarga del adjunto: el GET que salió hacia la URL del proveedor. */
function laDescarga(pedidos: Pedido[], url: string): Pedido | undefined {
  return pedidos.find((p) => p.url === url && p.method !== 'PUT');
}

describe('la llave del adjunto solo viaja al dominio del proveedor (#1317)', () => {
  it('una cuenta de Zernio baja su adjunto del API de Zernio CON su llave', async () => {
    const media = 'https://zernio.com/api/v1/whatsapp/media/abc';
    const salieron = await entraUnAdjunto(cuentaZernio, media, '+56955551311');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // La llave de SU cuenta — la de la otra no viaja por ser otra cuenta.
    expect(descarga?.authorization).toBe(`Bearer ${VALOR_ZERNIO}`);
  });

  it('la CDN del proveedor —un subdominio de zernio.com— también lleva la llave', async () => {
    const media = 'https://cdn.zernio.com/m/1.jpg';
    const salieron = await entraUnAdjunto(cuentaZernio, media, '+56955551312');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // No se sabe desde el código en qué host sirve el proveedor sus adjuntos,
    // así que se admite el dominio entero: la CDN propia es el caso real.
    expect(descarga?.authorization).toBe(`Bearer ${VALOR_ZERNIO}`);
  });

  it('una URL de OTRO dominio se baja SIN llave', async () => {
    // La URL sale del payload del webhook: la firma prueba el sobre, no cada
    // enlace de adentro. Un dominio ajeno —el de un atacante, o el de un
    // proveedor que venga— se consulta igual (el mensaje tiene que entrar
    // con su metadata), pero con la llave de ESTA cuenta no.
    const media = 'https://cdn.otronube.example/m/1.jpg';
    const salieron = await entraUnAdjunto(cuentaZernio, media, '+56955551313');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // La cabecera tiene que faltar, no llegar vacía: una cabecera vacía es una
    // cabecera que viaja igual.
    expect(descarga?.authorization).toBeUndefined();
  });

  it('la llave de OTRA cuenta no viaja aunque el dominio sea el de Zernio', async () => {
    // El caso cruzado que quedó de la coexistencia (#1317): dos cuentas,
    // dos llaves. La que baja el adjunto es la de la cuenta que lo recibió.
    const media = 'https://zernio.com/api/v1/whatsapp/media/xyz';
    const salieron = await entraUnAdjunto(cuentaOtra, media, '+56955551314');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    expect(descarga?.authorization).toBe(`Bearer ${VALOR_OTRA}`);
    expect(descarga?.authorization).not.toBe(`Bearer ${VALOR_ZERNIO}`);
  });
});
