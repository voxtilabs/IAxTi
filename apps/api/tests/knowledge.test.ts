import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { addSource, processSource, DIMENSIONES, type EmbedPort } from '@iaxti/module-knowledge';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API del conocimiento (#51): gestionar es del ADMIN, consultar el
// catálogo es del equipo, y sin llave de embeddings se avisa claro.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const vendedor = randomUUID(); // USER

const fakeEmbed: EmbedPort = {
  // Las dimensiones salen del módulo: escritas a mano, el día que cambie el
  // modelo el test pasa y la base rechaza (#502).
  async embed(texts) {
    return texts.map(() => new Array(DIMENSIONES).fill(0.01));
  },
};

async function pedir(quien: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(quien)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name, plan) VALUES ('test-knowledge-api', 'crece') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@know.cl', 'ADMIN'],
    [vendedor, 'vende@know.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

  // El catálogo directo por contract (la API de agregar exige llave de
  // embeddings, que este ambiente no tiene — eso también se prueba).
  const s = await withTenant(admin, tenant, (c) =>
    addSource(c, {
      tenantId: tenant,
      kind: 'catalogo',
      name: 'Catálogo',
      content: 'nombre,precio,stock\nManicure gel,18000,5',
      actor: 'test',
    }),
  );
  await withTenant(admin, tenant, (c) =>
    processSource(c, { tenantId: tenant, sourceId: s.id }, { embed: fakeEmbed }),
  );

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
  firmar = (sub) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setExpirationTime('5m')
      .sign(privateKey);
  app = await createApp({
    jwtVerify: async (token) => {
      const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER });
      return { userId: payload.sub as string };
    },
    resolveRole: dbRoleResolver(admin),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  for (const tabla of ['knowledge_query_cache', 'chunks', 'products', 'sources', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('/v1/knowledge (#51)', () => {
  it('gestionar fuentes es del ADMIN; el USER ni las ve', async () => {
    expect((await pedir(vendedor, '/knowledge/sources')).status).toBe(403);
    const res = await pedir(duena, '/knowledge/sources');
    expect(res.status).toBe(200);
    const fuentes = await res.json();
    expect(fuentes[0]).toMatchObject({ name: 'Catálogo', status: 'active' });
    expect(fuentes[0].chunkCount).toBe(1);
  });

  it('sin llave de embeddings, agregar avisa claro (503) — no adivina', async () => {
    const res = await pedir(duena, '/knowledge/sources', {
      method: 'POST',
      body: JSON.stringify({ kind: 'texto', name: 'Políticas', content: 'Atendemos de 10 a 19.' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');

    const malo = await pedir(duena, '/knowledge/sources', {
      method: 'POST',
      body: JSON.stringify({ kind: 'pergamino', name: 'X' }),
    });
    expect(malo.status).toBe(400);
  });

  it('get_product es del equipo: precio y stock como CAMPOS', async () => {
    const res = await pedir(vendedor, '/knowledge/products?q=manicure');
    expect(res.status).toBe(200);
    const productos = await res.json();
    expect(productos[0]).toMatchObject({ name: 'Manicure gel', price: 18000, stock: 5 });
  });

  it('eliminar una fuente arrasa con su índice', async () => {
    const [fuente] = await (await pedir(duena, '/knowledge/sources')).json();
    const res = await pedir(duena, `/knowledge/sources/${fuente.id}`, { method: 'DELETE' });
    expect((await res.json()).deleted).toBe(true);
    expect((await pedir(duena, `/knowledge/sources/${fuente.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('subir un PDF al conocimiento (#522)', () => {
  it('pide dónde ponerlo, y la llave nace con el prefijo del negocio', async () => {
    const r = await pedir(duena, '/knowledge/sources/pdf/destino', {
      method: 'POST',
      body: JSON.stringify({ filename: 'Lista de precios.pdf', sizeBytes: 120_000 }),
    });
    // Sin almacenamiento configurado en el ambiente de prueba se avisa claro,
    // que es el contrato: nunca adivinar un destino.
    if (r.status === 503) {
      expect((await r.json()).code).toBe('STORAGE_NOT_CONFIGURED');
      return;
    }
    expect(r.status).toBe(201);
    const cuerpo = await r.json();
    // El prefijo es de donde cuelga el aislamiento: la ruta que firma la
    // bajada solo acepta llaves que empiecen con el tenant de quien pide.
    expect(cuerpo.key.startsWith(`${tenant}/conocimiento/`)).toBe(true);
    expect(cuerpo.uploadUrl).toContain('X-Amz-Signature');
  });

  it('el nombre del archivo se limpia: no se puede salir del prefijo', async () => {
    const r = await pedir(duena, '/knowledge/sources/pdf/destino', {
      method: 'POST',
      body: JSON.stringify({ filename: '../../otro-negocio/secreto.pdf' }),
    });
    if (r.status === 503) return;
    const cuerpo = await r.json();
    expect(cuerpo.key.startsWith(`${tenant}/conocimiento/`)).toBe(true);
    expect(cuerpo.key).not.toContain('..');
    expect(cuerpo.key).not.toContain('otro-negocio/');
  });

  it('solo PDF, y con tope de tamaño comprobado en el servidor', async () => {
    const hoja = await pedir(duena, '/knowledge/sources/pdf/destino', {
      method: 'POST',
      body: JSON.stringify({ filename: 'precios.xlsx' }),
    });
    expect(hoja.status).toBe(400);

    // El tope se comprueba ACÁ y no solo en el navegador: una URL firmada
    // aceptaría lo que le manden, y el navegador es de quien sube.
    const gordo = await pedir(duena, '/knowledge/sources/pdf/destino', {
      method: 'POST',
      body: JSON.stringify({ filename: 'catalogo.pdf', sizeBytes: 50 * 1024 * 1024 }),
    });
    expect(gordo.status).toBe(400);
    expect((await gordo.json()).code).toBe('ARCHIVO_MUY_GRANDE');
  });

  it('una llave de OTRO negocio no registra nada', async () => {
    // La llave la devolvió esta API, pero vuelve por el navegador: si se
    // aceptara tal cual, un negocio podría indexar el documento de otro.
    const r = await pedir(duena, '/knowledge/sources/pdf', {
      method: 'POST',
      body: JSON.stringify({ key: 'otro-tenant/conocimiento/abc-precios.pdf', name: 'Ajeno' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('VALIDATION_ERROR');
  });

  it('sin la llave del proveedor multimodal avisa, no deja la fuente colgada', async () => {
    // Leer un PDF necesita Gemini: el catálogo de NVIDIA que sirve GLM no
    // tiene modelo multimodal (ADR-0025 §7). En este ambiente no hay llaves.
    const r = await pedir(duena, '/knowledge/sources/pdf', {
      method: 'POST',
      body: JSON.stringify({ key: `${tenant}/conocimiento/abc-precios.pdf`, name: 'Precios' }),
    });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('PROVIDER_UNAVAILABLE');

    // Y no quedó una fuente a medias: si la creara antes de comprobar, el
    // negocio vería un PDF "cargado" que la IA no puede leer.
    const fuentes = await (await pedir(duena, '/knowledge/sources')).json();
    expect(fuentes.filter((f: { kind: string }) => f.kind === 'pdf')).toEqual([]);
  });

  it('el vendedor no sube conocimiento', async () => {
    const r = await pedir(vendedor, '/knowledge/sources/pdf/destino', {
      method: 'POST',
      body: JSON.stringify({ filename: 'x.pdf' }),
    });
    expect(r.status).toBe(403);
  });
});
