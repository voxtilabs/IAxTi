import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool, runMigrations, sinTriggers, withTenant } from '@iaxti/db';
import { fuenteLimpia } from '@iaxti/core/testing';
import { createChannelAccount } from '@iaxti/module-channels';
import { processInbound, type InboundJob } from '../src/inbound';
import {
  TTL_FALLO_SEG,
  idDelJobDePerfil,
  resolverNombreDePerfil,
  sinMarca,
  type MarcaDeIntento,
  type PerfilJob,
} from '../src/perfil-de-whatsapp';

/**
 * El nombre de perfil de WhatsApp, de punta a punta (#1170).
 *
 * Son pruebas de COMPORTAMIENTO: entra un mensaje de verdad por
 * `processInbound`, con Postgres de verdad, y lo único falso es el `fetch` a
 * Zavu y la cola. Nunca se llama a la API real.
 *
 * Lo que se cuida acá y no se puede cuidar leyendo el archivo:
 *  · que el camino de entrada NO haga ninguna llamada HTTP — la decisión de
 *    diseño principal del issue, y la que ninguna prueba medía antes;
 *  · que una identidad opaca (BSUID, grupo) no gaste un viaje a Zavu;
 *  · que un nombre escrito por una persona no se pise NI SIQUIERA cuando lo
 *    escriben en el medio de la llamada, que es el único momento en que la
 *    carrera existe;
 *  · que la escritura quede en `audit_log`, mirando `audit_log`.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const CREDENCIAL = 'ZAVU_API_KEY_PRUEBA_1170';

let admin: Pool;
let tenant: string;
let cuenta: string;
let baseAnterior: string | undefined;
let pedidos: string[] = [];
let encolados: PerfilJob[] = [];

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * El `fetch` global que ve el proceso. Se deja puesto en TODAS las pruebas de
 * entrada, contestando con un nombre, para que la afirmación «no se llamó a
 * nadie» signifique algo: si el camino de entrada volviera a consultar en
 * línea, esta prueba lo vería y no se caería por otro motivo.
 */
function zavuResponde(responder: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request) => {
    pedidos.push(String(url));
    return responder(String(url));
  });
}

/** La cola, falsa: anota el job y nada más. */
const encolar = async (job: PerfilJob) => {
  encolados.push(job);
};

async function entra(data: Omit<InboundJob, 'tenantId'>) {
  return processInbound(admin, { tenantId: tenant, channelAccountId: cuenta, ...data }, encolar);
}

async function fichaDe(contactId: string) {
  return withTenant(admin, tenant, async (client) => {
    const r = await client.query('SELECT name, phone FROM contacts WHERE id = $1', [contactId]);
    return r.rows[0] as { name: string | null; phone: string | null };
  });
}

async function auditoriaDe(contactId: string) {
  const r = await admin.query(
    `SELECT actor, actor_kind, action, result, metadata FROM audit_log
      WHERE tenant_id = $1 AND resource = 'contact' AND resource_id = $2`,
    [tenant, contactId],
  );
  return r.rows as Array<{
    actor: string;
    actor_kind: string;
    action: string;
    result: string;
    metadata: Record<string, unknown>;
  }>;
}

/** Una marca de intento en memoria: el job tiene que poder medirse sin Redis. */
function marcaEnMemoria(): MarcaDeIntento & { claves: string[] } {
  const claves: string[] = [];
  return {
    claves,
    yaSePregunto: async (t, c) => claves.includes(`${t}:${c}`),
    anotar: async (t, c) => {
      claves.push(`${t}:${c}`);
    },
  };
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('perfil-1170') RETURNING id");
  tenant = t.rows[0].id;
  cuenta = await withTenant(admin, tenant, async (client) => {
    const account = await createChannelAccount(client, {
      tenantId: tenant,
      kind: 'whatsapp',
      name: 'Prueba 1170',
      credentialRef: CREDENCIAL,
    });
    return account.id;
  });
  process.env[CREDENCIAL] = 'zv_test_llave';
  // Que ni por error pueda salir a la API de verdad si alguien rompiera el
  // doble del `fetch`.
  baseAnterior = process.env.ZAVU_API_BASE;
  process.env.ZAVU_API_BASE = 'https://api.zavu.example/v1';
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  pedidos = [];
  encolados = [];
});

afterAll(async () => {
  delete process.env[CREDENCIAL];
  if (baseAnterior === undefined) delete process.env.ZAVU_API_BASE;
  else process.env.ZAVU_API_BASE = baseAnterior;
  if (tenant) {
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM assignments WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM channel_accounts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    // `audit_log` es append-only por trigger: sin `sinTriggers` esto revienta
    // justo porque la auditoría del nombre de perfil ahora SÍ escribe filas.
    await sinTriggers(admin, (c) =>
      c.query('DELETE FROM audit_log WHERE tenant_id = $1', [tenant]),
    );
    await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  }
  await admin?.end();
});

describe('el camino de entrada no espera a ningún tercero', () => {
  it('encola el nombre de perfil y NO hace ninguna llamada HTTP', async () => {
    // La decisión de diseño que el issue pone primero, medida.
    //
    // El defecto que esto caza: con la consulta esperada dentro de
    // `processInbound` —que es como estaba— `pedidos` tiene una entrada y cada
    // mensaje retiene hasta 4 s la ÚNICA ranura de la cola `inbound`, por la
    // que pasan además los estados de entrega y los webhooks de pago.
    zavuResponde(() =>
      json({ items: [{ id: 'z1', primaryPhone: '+56930000001', profileName: 'Javiera Rojas' }] }),
    );
    const res = await entra({ phone: '+56930000001', channel: 'whatsapp', body: 'hola' });

    expect(res.contactCreated).toBe(true);
    expect(res.messageId).toBeTruthy();
    expect(pedidos).toEqual([]);
    expect(encolados).toHaveLength(1);
    expect(encolados[0]).toMatchObject({
      moduleId: 'whatsapp',
      tenantId: tenant,
      contactId: res.contactId,
      // El E.164 que YA quedó guardado, no `data.phone` crudo.
      identidad: { tipo: 'telefono', telefono: '+56930000001' },
      credencialRef: CREDENCIAL,
    });
    // Y el contacto sigue con su número hasta que corra el job: el mensaje
    // entró primero, que es el punto.
    expect((await fichaDe(res.contactId)).name).toBeNull();
  });

  it('si no se puede encolar, el mensaje entra igual', async () => {
    zavuResponde(() => json({ items: [] }));
    const res = await processInbound(
      admin,
      { tenantId: tenant, channelAccountId: cuenta, phone: '+56930000011', channel: 'whatsapp', body: 'hola' },
      async () => {
        throw Object.assign(new Error('ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
      },
    );
    expect(res.messageId).toBeTruthy();
  });
});

describe('el `jobId` junta la ráfaga sin cerrar la puerta para siempre', () => {
  it('dos mensajes seguidos del mismo contacto comparten el id; media hora después, no', () => {
    // Lo que la ventana evita: BullMQ ignora un `add` con un `jobId` que ya
    // existe, y con `removeOnComplete: 1000` un job COMPLETADO sigue existiendo
    // hasta que lo desplacen mil más nuevos. Con el id fijo por contacto, un
    // negocio tranquilo no volvía a preguntar NUNCA — ni cuando venciera la
    // marca de 15 minutos que se pone cuando el que falla es Zavu.
    const job: PerfilJob = {
      tenantId: 't1',
      contactId: 'c1',
      identidad: { tipo: 'telefono', telefono: '+56930000001' },
      credencialRef: CREDENCIAL,
    };
    const ahora = 1_762_000_000_000;
    expect(idDelJobDePerfil(job, ahora)).toBe(idDelJobDePerfil(job, ahora + 1_000));
    expect(idDelJobDePerfil(job, ahora)).not.toBe(
      idDelJobDePerfil(job, ahora + 2 * TTL_FALLO_SEG * 1_000),
    );
    // Y dos contactos distintos nunca comparten id.
    expect(idDelJobDePerfil({ ...job, contactId: 'c2' }, ahora)).not.toBe(
      idDelJobDePerfil(job, ahora),
    );
  });
});

describe('las identidades que no son un teléfono no se le preguntan a Zavu', () => {
  it('un BSUID no sale a buscar nada por teléfono', async () => {
    // El defecto medido: `digitos('US.13491208655302741918')` deja 20 dígitos,
    // así que la guarda de «parece un teléfono» no lo paraba y salía un
    // `GET /contacts?search=1349…` por CADA mensaje de ese contacto, para
    // siempre, que jamás podía calzar contra un `phoneNumber`.
    zavuResponde(() => json({ items: [{ id: 'z0', profileName: 'No deberia' }] }));
    const res = await entra({
      phone: 'US.13491208655302741918',
      channel: 'whatsapp',
      body: 'hola',
    });

    expect(res.messageId).toBeTruthy();
    // El contacto de una identidad opaca nace con `phone = NULL`.
    expect((await fichaDe(res.contactId)).phone).toBeNull();
    expect(pedidos).toEqual([]);
    // Se encola, pero como BSUID: la búsqueda se comprueba contra
    // `whatsapp.bsuid`, que es la llave que sí lo identifica.
    expect(encolados).toHaveLength(1);
    expect(encolados[0].identidad).toEqual({
      tipo: 'bsuid',
      bsuid: 'US.13491208655302741918',
    });
  });

  it('un grupo no tiene nombre de perfil: no se encola ni se consulta', async () => {
    zavuResponde(() => json({ items: [{ id: 'z0', profileName: 'No deberia' }] }));
    const res = await entra({ phone: '123456789@g.us', channel: 'whatsapp', body: 'hola' });

    expect(res.messageId).toBeTruthy();
    expect(pedidos).toEqual([]);
    expect(encolados).toEqual([]);
  });
});

describe('lo que ya está escrito manda', () => {
  it('con nombre puesto no se encola nada', async () => {
    zavuResponde(() => json({ items: [] }));
    const primero = await entra({ phone: '+56930000003', channel: 'whatsapp', body: 'hola' });
    await withTenant(admin, tenant, (client) =>
      client.query('UPDATE contacts SET name = $2 WHERE id = $1', [
        primero.contactId,
        'Don Luis (cliente antiguo)',
      ]),
    );
    encolados = [];

    const segundo = await entra({ phone: '+56930000003', channel: 'whatsapp', body: 'de nuevo' });
    expect((await fichaDe(segundo.contactId)).name).toBe('Don Luis (cliente antiguo)');
    expect(encolados).toEqual([]);
  });

  it('NI SIQUIERA si lo escriben mientras Zavu contesta', async () => {
    // Acá está la única carrera que existe de verdad, y la que antes no medía
    // nada: entre la decisión de consultar y la escritura pasa una llamada de
    // red entera. El defecto se pone rojo quitando la relectura dentro de la
    // transacción (`if (!contacto) return` en vez de mirar el nombre).
    const res = await entra({ phone: '+56930000012', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];
    expect(trabajo).toBeTruthy();

    let consultas = 0;
    const fetchQueEscribeEnElMedio = (async () => {
      consultas += 1;
      // Una vendedora abre la ficha y escribe el nombre real, justo ahora.
      await withTenant(admin, tenant, (c) =>
        c.query('UPDATE contacts SET name = $2 WHERE id = $1', [
          res.contactId,
          'Don Luis (cliente antiguo)',
        ]),
      );
      return json({
        items: [{ id: 'z12', primaryPhone: '+56930000012', profileName: 'lucho 🔥' }],
      });
    }) as unknown as typeof globalThis.fetch;

    const resultado = await resolverNombreDePerfil(admin, trabajo, {
      fetch: fetchQueEscribeEnElMedio,
      marca: sinMarca,
    });

    expect(consultas).toBeGreaterThan(0);
    expect(resultado).toBe('ya-tenia-nombre');
    expect((await fichaDe(res.contactId)).name).toBe('Don Luis (cliente antiguo)');
  });
});

describe('el job que le pone el nombre a la ficha', () => {
  it('el contacto deja de ser un número, y queda en audit_log', async () => {
    const res = await entra({ phone: '+56930000002', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];

    const llamadas: string[] = [];
    const llamar = (async (url: string) => {
      llamadas.push(String(url));
      return json({
        items: [
          {
            id: 'z2',
            primaryPhone: '+56930000002',
            phoneNumber: '+56930000002',
            profileName: 'Matías Soto',
            whatsapp: { bsuid: 'bs_2' },
          },
        ],
      });
    }) as unknown as typeof globalThis.fetch;

    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar })).toBe('puesto');
    expect((await fichaDe(res.contactId)).name).toBe('Matías Soto');
    expect(new URL(llamadas[0]).searchParams.get('phoneNumber')).toBe('+56930000002');

    // Mira `audit_log`, que es la tabla que el nombre de esta prueba promete.
    // La versión anterior se llamaba «y queda auditado» y consultaba `outbox`:
    // `updateContact` NO audita, solo publica `contact.updated`, así que
    // Auditoría devolvía cero filas con la prueba en verde.
    const libro = await auditoriaDe(res.contactId);
    expect(libro).toHaveLength(1);
    expect(libro[0]).toMatchObject({
      actor: 'system',
      actor_kind: 'system',
      action: 'contact.profile_name_set',
      result: 'success',
    });
    // Y en el metadata NADA del dato personal: el libro se exporta.
    const metadata = JSON.stringify(libro[0].metadata);
    expect(metadata).not.toContain('Matías');
    expect(metadata).not.toContain('56930000002');

    // El evento sigue saliendo con el actor del sistema, que es lo que mira la
    // bandeja en vivo.
    const evento = await admin.query(
      `SELECT actor FROM outbox WHERE tenant_id = $1 AND name = 'contact.updated'
         AND payload->>'contactId' = $2`,
      [tenant, res.contactId],
    );
    expect(evento.rows.map((f) => f.actor)).toContain('system');
  });

  it('no se le vuelve a preguntar por un contacto que no tiene nombre de perfil', async () => {
    // El defecto que esto caza: sin marca de intento, cada mensaje de la misma
    // persona repetía la llamada para siempre. Treinta mensajes, treinta GET.
    const res = await entra({ phone: '+56930000013', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];
    const marca = marcaEnMemoria();

    let consultas = 0;
    const llamar = (async () => {
      consultas += 1;
      return json({ items: [] });
    }) as unknown as typeof globalThis.fetch;

    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar, marca })).toBe('sin-nombre');
    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar, marca })).toBe(
      'ya-se-habia-preguntado',
    );
    // Dos pedidos de la PRIMERA corrida (filtro exacto + búsqueda), ninguno de
    // la segunda.
    expect(consultas).toBe(2);
    expect((await fichaDe(res.contactId)).name).toBeNull();
  });

  it('con Zavu caído el contacto queda con su número y el job no se cae', async () => {
    const res = await entra({ phone: '+56930000004', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];
    const llamar = (async () => json({ error: 'nope' }, 500)) as unknown as typeof globalThis.fetch;

    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar })).toBe('sin-nombre');
    expect((await fichaDe(res.contactId)).name).toBeNull();
    expect(await auditoriaDe(res.contactId)).toEqual([]);
  });

  it('con la red caída tampoco se cae', async () => {
    const res = await entra({ phone: '+56930000005', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];
    const llamar = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar })).toBe('sin-nombre');
    expect((await fichaDe(res.contactId)).name).toBeNull();
  });

  it('si Zavu devuelve otro contacto, la ficha NO se queda con ese nombre', async () => {
    // La trampa vista desde el producto: la lista entera con otra persona
    // primero. El nombre ajeno en una ficha es peor que el número.
    const res = await entra({ phone: '+56930000006', channel: 'whatsapp', body: 'hola' });
    const trabajo = encolados[0];
    const llamar = (async () =>
      json({
        items: [
          { id: 'z9', primaryPhone: '+56999999999', profileName: 'Carolina Díaz' },
          { id: 'z8', primaryPhone: '+56988888888', profileName: 'Pedro Pérez' },
        ],
      })) as unknown as typeof globalThis.fetch;

    expect(await resolverNombreDePerfil(admin, trabajo, { fetch: llamar })).toBe('sin-nombre');
    expect((await fichaDe(res.contactId)).name).toBeNull();
  });
});

describe('solo WhatsApp', () => {
  it('el simulador no va a buscar nombres a ninguna parte', async () => {
    zavuResponde(() => json({ items: [{ id: 'z7', primaryPhone: '+56930000007', profileName: 'X' }] }));
    await entra({ phone: '+56930000007', channel: 'simulador', body: 'hola' });
    expect(pedidos).toEqual([]);
    expect(encolados).toEqual([]);
  });

  it('sin cuenta de canal no hay credencial, y no se encola', async () => {
    zavuResponde(() => json({ items: [{ id: 'z6', primaryPhone: '+56930000008', profileName: 'X' }] }));
    await processInbound(
      admin,
      { tenantId: tenant, phone: '+56930000008', channel: 'whatsapp', body: 'hola' },
      encolar,
    );
    expect(pedidos).toEqual([]);
    expect(encolados).toEqual([]);
  });
});

describe('el log del cableado no lleva datos personales', () => {
  it('ni el nombre, ni el teléfono, ni el `message` del error', () => {
    // Guarda de FUENTE: la pregunta es «¿está escrito?». El camino del nombre
    // de perfil registra MOTIVOS, y el `message` de un error no es un motivo:
    // `normalizePhone` revienta con el teléfono dentro del texto, así que
    // copiarlo al log manda el número sin que nada falle.
    const fuente = fuenteLimpia(
      readFileSync(join(__dirname, '..', 'src', 'perfil-de-whatsapp.ts'), 'utf8'),
    );
    expect(fuente).toContain('console.warn');
    expect(fuente).not.toContain('.message');
    expect(fuente).not.toContain('${nombre}');
    expect(fuente).not.toContain('identidad.telefono');
    expect(fuente).not.toContain('contacto.phone');
  });

  it('el camino de entrada no importa la consulta a Zavu', () => {
    // La otra mitad de «el mensaje entra primero», como guarda de fuente: si
    // alguien vuelve a traer `nombreDePerfil` a `inbound.ts`, la llamada HTTP
    // vuelve a la cola que corre de a uno. La prueba de comportamiento de
    // arriba mide el efecto; esta nombra la causa.
    const fuente = fuenteLimpia(readFileSync(join(__dirname, '..', 'src', 'inbound.ts'), 'utf8'));
    expect(fuente).not.toContain('nombreDePerfil');
    expect(fuente).not.toContain('fetch');
  });
});
