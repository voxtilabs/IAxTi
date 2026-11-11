import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { createChannelAccount } from '@iaxti/module-channels';
import { processInbound, type InboundJob } from '../src/inbound';

/**
 * La llave que baja un adjunto es del proveedor de la CUENTA (#1317, #1335).
 *
 * `processInbound` decide qué dominio puede recibir la llave según el
 * `provider` de la cuenta: a una cuenta de Zernio le pasa `apiBase:
 * baseDeZernio()` —y `llevaCredencial` deja viajar la llave solo a ese
 * dominio—, y a una de Zavu no le pasa nada, con lo que la cerradura es la de
 * Zavu. Sin esa línea, desde #1336 los adjuntos de una cuenta de Zernio se
 * pedían a zernio.com SIN llave —el dominio por omisión es el de Zavu— y no
 * entraba ninguno: falla segura, pero falla.
 *
 * Entra por `processInbound` —el camino real del worker— con Postgres de
 * verdad y una cuenta de canal de verdad en la base; lo único falso es el
 * `fetch`, que se espía para leer la cabecera de la PETICIÓN que sale. Lo que
 * se cubre y lo que no:
 *
 *  · SÍ: la decisión de `inbound.ts` (qué `apiBase` se le pasa a la descarga
 *    según el `provider` de la cuenta) medida por el puerto, con las tres
 *    combinaciones que importan: zernio→zernio.com con llave, zavu→zernio.com
 *    sin llave, zavu→cdn.zavu.dev con llave.
 *  · SÍ: que la llave que viaja es la de SU cuenta y no la de la otra.
 *  · NO: `llevaCredencial` en sí —sus bordes (`startsWith`, `@`, `http:`) los
 *    prueba `la-llave-no-sale-del-proveedor.test.ts` en el módulo whatsapp.
 *  · NO: el envío SALIENTE ni la firma del webhook de Zernio —los prueba
 *    `el-adaptador-de-zernio.test.ts`.
 */

/** La base de pruebas del monorepo: NUNCA el 5432, que es de otro proyecto. */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5433/iaxti_pruebas';

const LLAVE_ZERNIO = 'LLAVE_DE_PRUEBA_1317_ZERNIO';
const LLAVE_ZAVU = 'LLAVE_DE_PRUEBA_1317_ZAVU';
const VALOR_ZERNIO = 'zr_llave_de_la_cuenta_de_zernio';
const VALOR_ZAVU = 'zv_llave_de_la_cuenta_de_zavu';

let admin: Pool;
let tenant: string;
let cuentaZernio: string;
let cuentaZavu: string;

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
  cuentaZavu = await withTenant(admin, tenant, async (client) => {
    const account = await createChannelAccount(client, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Cuenta de Zavu 1317',
      credentialRef: LLAVE_ZAVU,
    });
    return account.id;
  });
  cuentaZernio = await withTenant(admin, tenant, async (client) => {
    const account = await createChannelAccount(client, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Cuenta de Zernio 1317',
      credentialRef: LLAVE_ZERNIO,
    });
    // `createChannelAccount` no declara proveedor: nace con el por omisión de
    // la migración 0006. Pasar a Zernio es migrar la cuenta, y eso hoy es SQL
    // —mismo camino que usa `el-proveedor-es-de-la-cuenta.test.ts`.
    await client.query('UPDATE channel_accounts SET provider = $2 WHERE id = $1', [
      account.id,
      'zernio',
    ]);
    return account.id;
  });
  process.env[LLAVE_ZERNIO] = VALOR_ZERNIO;
  process.env[LLAVE_ZAVU] = VALOR_ZAVU;
  // R2 puesto: esta prueba mide la DESCARGA, y sin almacenamiento el camino se
  // salta entero y no sale ninguna petición que espiar.
  process.env.R2_ENDPOINT = 'https://cuenta-prueba.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'llave-de-prueba';
  process.env.R2_SECRET_ACCESS_KEY = 'secreto-de-prueba';
  process.env.R2_BUCKET_ADJUNTOS = 'adjuntos-prueba';
  // Las bases se fijan a propósito y no se dejan al ambiente: `llevaCredencial`
  // deriva el dominio de la cerradura de la base, y una ambiente con otra base
  // cambiaría qué hosts son «del proveedor» sin que esta prueba lo note.
  process.env.ZAVU_API_BASE = 'https://api.zavu.dev/v1';
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
  delete process.env[LLAVE_ZAVU];
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_ADJUNTOS;
  delete process.env.ZAVU_API_BASE;
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

describe('la llave del adjunto sigue al proveedor de la cuenta (#1317)', () => {
  it('una cuenta de Zernio baja su adjunto de zernio.com CON su llave', async () => {
    const media = 'https://zernio.com/api/v1/whatsapp/media/abc';
    const salieron = await entraUnAdjunto(cuentaZernio, media, '+56955551311');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // La llave de SU cuenta — la de Zavu no viaja por ser otra cuenta, y
    // antes de #1336 ninguna viajaba por ser otro dominio.
    expect(descarga?.authorization).toBe(`Bearer ${VALOR_ZERNIO}`);
  });

  it('una cuenta de Zavu NO manda su llave a zernio.com', async () => {
    const media = 'https://zernio.com/api/v1/whatsapp/media/xyz';
    const salieron = await entraUnAdjunto(cuentaZavu, media, '+56955551312');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // La cabecera tiene que faltar, no llegar vacía: una cabecera vacía es una
    // cabecera que viaja igual, y esta es la llave de Zavu en el dominio de
    // OTRO proveedor — exactamente lo que #1336 vino a cerrar.
    expect(descarga?.authorization).toBeUndefined();
  });

  it('una cuenta de Zavu sigue bajando de cdn.zavu.dev CON su llave', async () => {
    const media = 'https://cdn.zavu.dev/m/1.jpg';
    const salieron = await entraUnAdjunto(cuentaZavu, media, '+56955551313');
    const descarga = laDescarga(salieron, media);
    expect(descarga, `no se pidió el adjunto. Lo que salió:\n${JSON.stringify(salieron)}`).toBeTruthy();
    // El comportamiento de siempre, que #1336 no podía romper al cerrar la
    // puerta: la CDN propia del proveedor sigue llevando la llave.
    expect(descarga?.authorization).toBe(`Bearer ${VALOR_ZAVU}`);
  });
});