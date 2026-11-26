import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact } from '@iaxti/module-crm';
import { createApp } from '../src/main';
import { usarPool } from '../src/db';
import { ESQUEMAS_DE_CUERPO } from '../src/validar';

/**
 * El alta de contactos a mano por la puerta de la API (#1395).
 *
 * El guard, el cuerpo y el contrato OpenAPI — lo que toda ruta nueva debe
 * traer (regla de testing): sin permiso responde 403 en el formato único, el
 * cuerpo se valida con esquema, y la ruta aparece en `/docs-json` con su
 * permiso, su módulo y la forma de sus argumentos, que es lo que el catálogo
 * de la IA y el SDK derivan.
 *
 * La identidad entra por los headers de desarrollo (X-User-Id/X-Tenant-Id/
 * X-Role): con `jwtVerify: null` el guard los acepta, y así el test no
 * depende de Supabase para probar lo que no es Supabase.
 */
const url = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let app: INestApplication;
let base: string;
let pool: Pool;
let tenant: string;
const user = randomUUID();

type Respuesta = { code: string; message: string; requestId: string; details: unknown[] };

async function pedir(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      'X-User-Id': user,
      'X-Tenant-Id': tenant,
      'X-Role': 'USER',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      ...headers,
    },
  });
}

beforeAll(async () => {
  pool = createPool(url);
  await runMigrations(pool);
  usarPool(pool);
  tenant = (await pool.query("INSERT INTO tenants (name) VALUES ('crear-contacto') RETURNING id")).rows[0].id;
  app = await createApp({
    jwtVerify: null,
    resolveRole: null,
    resolvePlatformAdmin: async () => false,
    resolveCustomPermissions: null,
    resolveAccesoModulo: null,
  });
  await app.listen(0);
  base = await app.getUrl();
}, 60_000);

afterAll(async () => {
  await app?.close();
  usarPool(null);
  await pool?.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await pool?.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await pool?.end();
});

describe('POST /v1/contacts (#1395)', () => {
  it('sin crm.contacts.create responde 403 en el formato único', async () => {
    // USER, SUPERVISOR y ADMIN tienen el permiso (§23); un rol que no está
    // en el catálogo no concede nada.
    const res = await pedir(
      '/contacts',
      { method: 'POST', body: JSON.stringify({ phone: '+56981234599' }) },
      { 'X-Role': 'CONTADOR' },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Respuesta;
    expect(body).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.any(String) });
    expect(body.requestId).toMatch(/^req_/);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('el cuerpo se valida: sin teléfono, correo mal escrito o nombre infinito', async () => {
    for (const cuerpo of [
      {},
      { name: 'Sin teléfono' },
      { phone: '+56981234599', email: 'no-es-un-correo' },
      { phone: '+56981234599', name: 'x'.repeat(121) },
    ]) {
      const res = await pedir('/contacts', { method: 'POST', body: JSON.stringify(cuerpo) });
      expect(res.status, JSON.stringify(cuerpo)).toBe(400);
      const body = (await res.json()) as Respuesta;
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.message).not.toMatch(/Invalid input|Expected/);
    }
    // El mensaje del teléfono obligado dice qué escribir, no «Required».
    const sinPhone = (await (await pedir('/contacts', { method: 'POST', body: '{}' })).json()) as Respuesta;
    expect(sinPhone.message).toMatch(/\+569/);
  });

  it('crea el contacto a mano: 201, origen manual y sin permiso para escribirle', async () => {
    const res = await pedir('/contacts', {
      method: 'POST',
      body: JSON.stringify({ phone: '9 8123 4599', name: 'Amelia Suazo', email: 'AMELIA@ejemplo.cl' }),
    });
    expect(res.status).toBe(201);
    const creado = (await res.json()) as Record<string, unknown>;
    expect(creado).toMatchObject({
      phone: '+56981234599',
      name: 'Amelia Suazo',
      email: 'amelia@ejemplo.cl',
      origin: 'manual',
      opt_in_at: null,
    });

    // La MISMA forma que la ficha: lo que devuelve crear es lo que devuelve
    // GET /contacts/:id en su campo contact, sin volver a pedir nada.
    const ficha = await (await pedir(`/contacts/${creado.id}`)).json();
    expect((ficha as { contact: unknown }).contact).toEqual(creado);

    // Nace sin permiso: anotado no es autorizado (SPEC §8).
    const lista = await (await pedir('/contacts?filter[permiso]=sin_permiso&q=Amelia')).json();
    const items = (lista as { items: Array<{ id: string; permiso: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(creado.id);

    // La auditoría queda escrita en la misma transacción, con el origen y sin
    // datos personales en el metadata.
    const audit = await withTenant(pool, tenant, (c) =>
      c.query('SELECT actor, actor_kind, action, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2', [
        tenant,
        creado.id,
      ]),
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({ actor: user, actor_kind: 'user', action: 'contact.created' });
    expect(audit.rows[0].metadata).toEqual({ origin: 'manual' });
    expect(JSON.stringify(audit.rows[0])).not.toContain('Amelia');
    expect(JSON.stringify(audit.rows[0])).not.toContain('+56981234599');
  });

  it('un teléfono que no es teléfono responde 400 y señala el campo', async () => {
    const antes = await (await pedir('/contacts?limit=100')).json();
    const res = await pedir('/contacts', { method: 'POST', body: JSON.stringify({ phone: 'patito' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Respuesta;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/\+569/);
    expect(body.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'phone' })]));
    // Y no creó nada.
    const despues = await (await pedir('/contacts?limit=100')).json();
    expect((despues as { items: unknown[] }).items).toHaveLength((antes as { items: unknown[] }).items.length);
  });

  it('el teléfono repetido responde 409 con el id del existente', async () => {
    const primero = await pedir('/contacts', {
      method: 'POST',
      body: JSON.stringify({ phone: '+56981234588', name: 'Ya estaba' }),
    });
    expect(primero.status).toBe(201);
    const existente = (await primero.json()) as { id: string };

    const segundo = await pedir('/contacts', {
      method: 'POST',
      body: JSON.stringify({ phone: '+56 9 8123 4588', name: 'Duplicado' }),
    });
    expect(segundo.status).toBe(409);
    const body = (await segundo.json()) as Respuesta;
    expect(body.code).toBe('CONTACT_EXISTS');
    expect(body.message).toMatch(/Ya tienes un contacto con ese teléfono/);
    expect(body.details).toEqual([{ contactId: existente.id }]);
    expect(body.requestId).toMatch(/^req_/);
  });
});

describe('los filtros de GET /v1/contacts en la URL (#1395)', () => {
  beforeAll(async () => {
    // Un contacto por cada combinación que importa para el filtro, en ESTE
    // tenant: canal con opt-in, canal sin nada, importado con baja y manual.
    // Se crean por el contrato del módulo porque el origen no entra por el
    // cuerpo del POST — a mano siempre nace manual.
    for (const [phone, origin, optIn, baja] of [
      ['+56981231101', 'whatsapp', true, false],
      ['+56981231102', 'whatsapp', false, false],
      ['+56981231103', 'importado', false, true],
      ['+56981231104', 'manual', false, false],
    ] as const) {
      const { id } = await withTenant(pool, tenant, (c) =>
        createContact(c, { tenantId: tenant, phone, origin, name: `Filtro ${origin}` }),
      );
      if (optIn) {
        await withTenant(pool, tenant, (c) =>
          c.query(
            'UPDATE contacts SET opt_in_at = now(), opt_in_channel = $3, opt_in_evidence = $4 WHERE tenant_id = $1 AND id = $2',
            [tenant, id, 'formulario', 'checkeo en caja'],
          ),
        );
      }
      if (baja) {
        await withTenant(pool, tenant, (c) =>
          c.query('UPDATE contacts SET opted_out_at = now() WHERE tenant_id = $1 AND id = $2', [tenant, id]),
        );
      }
    }
  });

  it('filter[origen] y filter[permiso] filtran, juntos o con q', async () => {
    const manuales = await (await pedir('/contacts?filter[origen]=manual')).json();
    expect((manuales as { items: Array<{ origin: string }> }).items.every((i) => i.origin === 'manual')).toBe(true);
    expect((manuales as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const deBaja = await (await pedir('/contacts?filter[permiso]=baja')).json();
    expect((deBaja as { items: Array<{ permiso: string; phone: string }> }).items).toHaveLength(1);
    expect((deBaja as { items: Array<{ phone: string }> }).items[0].phone).toBe('+56981231103');

    const combinado = await (await pedir('/contacts?filter[origen]=whatsapp&filter[permiso]=puede')).json();
    expect((combinado as { items: Array<{ origin: string; permiso: string }> }).items).toHaveLength(2);
    expect((combinado as { items: Array<{ phone: string }> }).items.map((i) => i.phone).sort()).toEqual([
      '+56981231101',
      '+56981231102',
    ]);

    const conQ = await (await pedir('/contacts?filter[origen]=manual&q=Amelia')).json();
    expect((conQ as { items: Array<{ phone: string }> }).items.map((i) => i.phone)).toEqual(['+56981234599']);
  });

  it('un valor desconocido o un filtro mal escrito responde 400 INVALID_LIST_QUERY', async () => {
    // Un filtro que se ignora en silencio es la lista equivocada con cara de
    // correcta: se rechaza y se dice cuáles existen.
    for (const query of [
      'filter[origen]=telegram',
      'filter[permiso]=OPT_IN',
      'filter[origen]=manual&filter[origen]=manual',
      'filter=manual',
      'filter[ciudad]=santiago',
      // Un parámetro repetido tampoco se deja caer en silencio (#546).
      'q=Amelia&q=Rosa',
    ]) {
      const res = await pedir(`/contacts?${query}`);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as Respuesta).code).toBe('INVALID_LIST_QUERY');
    }
  });

  it('el cursor de una búsqueda con filtro no sirve para otra', async () => {
    const pagina = await (await pedir('/contacts?filter[origen]=whatsapp&limit=1')).json();
    const cursor = (pagina as { nextCursor: string | null }).nextCursor;
    expect(cursor).toBeTruthy();
    const misma = await pedir(`/contacts?filter[origen]=whatsapp&limit=1&cursor=${cursor}`);
    expect(misma.status).toBe(200);
    const otra = await pedir(`/contacts?limit=1&cursor=${cursor}`);
    expect(otra.status).toBe(400);
    expect(((await otra.json()) as Respuesta).code).toBe('INVALID_LIST_QUERY');
  });
});

describe('el contrato OpenAPI publica la ruta nueva', () => {
  it('POST /v1/contacts con su permiso, su módulo y la forma del cuerpo', async () => {
    const doc = await (await fetch(`${base}/docs-json`)).json();
    const post = doc.paths['/v1/contacts'].post;
    expect(post).toMatchObject({
      operationId: 'ContactsController_create',
      summary: 'Agrega un contacto a mano (nace sin permiso para escribirle)',
      'x-iaxti-permission': 'crm.contacts.create',
      'x-iaxti-module': 'crm',
    });
    // La forma del cuerpo la registra el decorador @Cuerpo (#524): Nest no la
    // publica, y sin ella el catálogo de la IA llamaría a ciegas.
    const esquema = ESQUEMAS_DE_CUERPO.get('ContactsController_create') as {
      required?: string[];
      properties?: Record<string, { type?: string }>;
    };
    expect(esquema?.required).toEqual(['phone']);
    expect(esquema?.properties).toMatchObject({
      phone: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    });
  });

  it('los dos filter[...] aparecen como parámetros de la lista', async () => {
    const doc = await (await fetch(`${base}/docs-json`)).json();
    const parametros = doc.paths['/v1/contacts'].get.parameters as Array<{
      name: string;
      schema?: { enum?: string[] };
    }>;
    const porNombre = Object.fromEntries(parametros.map((p) => [p.name, p]));
    expect(porNombre['filter[origen]'].schema?.enum).toEqual([
      'whatsapp',
      'webchat',
      'importado',
      'manual',
      'instagram',
      'messenger',
    ]);
    expect(porNombre['filter[permiso]'].schema?.enum).toEqual(['puede', 'sin_permiso', 'baja']);
  });
});
