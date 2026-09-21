import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { resolveApiKey } from '@iaxti/module-authorization';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * El producto como servidor MCP (#419).
 *
 * Lo que importa probar no es el protocolo —son cuatro métodos— sino que la
 * lista de herramientas salga de los permisos DE LA KEY y no de una lista
 * escrita a mano: una key sin un scope no debe VER esa herramienta, no solo
 * fallar al llamarla.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();

/** Una petición JSON-RPC con la key como Bearer, que es lo que manda un cliente MCP. */
async function rpc(token: string, method: string, params?: Record<string, unknown>, id: number | null = 1) {
  const res = await fetch(`${base}/v1/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
  });
  return { status: res.status, cuerpo: await res.json() };
}

async function crearKey(scopes: string[]): Promise<string> {
  const res = await fetch(`${base}/v1/apikeys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `mcp-${scopes.length}-${randomUUID().slice(0, 8)}`, scopes }),
  });
  return (await res.json()).token;
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-mcp') RETURNING id");
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'dueña@mcp.cl', roleName: 'ADMIN' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: duena }));

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
    resolveApiKey: (token) => resolveApiKey(admin, token),
  });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  // `audit_log` NO se limpia: es append-only y el trigger rechaza el
  // DELETE. Que este afterAll fallara la primera vez es la prueba de que
  // esa garantía está viva.
  for (const tabla of ['api_keys', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  await admin.end();
});

describe('POST /v1/mcp (#419)', () => {
  it('el handshake responde la versión del protocolo y qué sabe hacer', async () => {
    const key = await crearKey(['agents.use', 'analytics.read']);
    const { cuerpo } = await rpc(key, 'initialize');
    expect(cuerpo.result.protocolVersion).toBe('2025-06-18');
    expect(cuerpo.result.capabilities.tools).toBeDefined();
    expect(cuerpo.result.serverInfo.name).toBe('iaxti');
  });

  it('la notificación de "ya estoy listo" no se contesta con un error', async () => {
    // Llega SIEMPRE después del handshake. Contestarle "método
    // desconocido" deja al cliente creyendo que el servidor no habla el
    // protocolo, y la sesión se cae antes de pedir una sola herramienta.
    const key = await crearKey(['agents.use']);
    const { cuerpo } = await rpc(key, 'notifications/initialized', undefined, null);
    expect(cuerpo.error).toBeUndefined();
  });

  it('tools/list muestra SOLO lo que esa key puede ejecutar', async () => {
    const conNumeros = await crearKey(['agents.use', 'analytics.read']);
    const sinNumeros = await crearKey(['agents.use', 'conversations.read']);

    const a = (await rpc(conNumeros, 'tools/list')).cuerpo.result.tools.map((t: { name: string }) => t.name);
    const b = (await rpc(sinNumeros, 'tools/list')).cuerpo.result.tools.map((t: { name: string }) => t.name);

    expect(a).toContain('analytics.metrica');
    // No está: no es que falle al llamarla. Ofrecer algo que va a fallar es
    // peor que no ofrecerlo, porque el modelo del otro lado lo intenta.
    expect(b).not.toContain('analytics.metrica');
    expect(b).toContain('conversations.get_context');
  });

  it('cada herramienta viene con su esquema de entrada', async () => {
    const key = await crearKey(['agents.use', 'analytics.read']);
    const tools = (await rpc(key, 'tools/list')).cuerpo.result.tools;
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('llamar una herramienta que la key no tiene NO rompe la sesión: la explica', async () => {
    const key = await crearKey(['agents.use', 'conversations.read']);
    const { cuerpo } = await rpc(key, 'tools/call', { name: 'analytics.metrica', arguments: {} });
    expect(cuerpo.error).toBeUndefined(); // no es error de protocolo
    expect(cuerpo.result.isError).toBe(true);
    expect(cuerpo.result.content[0].text).toContain('no está disponible');
  });

  it('una herramienta inventada tampoco es un error de protocolo', async () => {
    const key = await crearKey(['agents.use']);
    const { cuerpo } = await rpc(key, 'tools/call', { name: 'crm.borrar_todo', arguments: {} });
    expect(cuerpo.result.isError).toBe(true);
  });

  it('ejecuta de verdad: el catálogo de métricas sale con sus definiciones', async () => {
    const key = await crearKey(['agents.use', 'analytics.read']);
    const { cuerpo } = await rpc(key, 'tools/call', {
      name: 'analytics.catalogo',
      arguments: {},
    });
    expect(cuerpo.result.isError).toBe(false);
    expect(cuerpo.result.content[0].text).toContain('metrica');
  });

  it('cada llamada deja rastro, y se sabe que fue por una key', async () => {
    // El libro es lo que permite responder "¿quién hizo esto?" seis meses
    // después. Una IA de afuera moviendo el CRM sin rastro sería lo peor
    // de las dos cosas: nadie adentro lo vio y nadie afuera responde.
    const key = await crearKey(['agents.use', 'analytics.read']);
    await rpc(key, 'tools/call', { name: 'analytics.catalogo', arguments: {} });

    const r = await admin.query(
      `SELECT actor, actor_kind, action, result FROM audit_log
        WHERE tenant_id = $1 AND action = 'agent.tool.analytics.catalogo'
        ORDER BY occurred_at DESC LIMIT 1`,
      [tenant],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].result).toBe('ok');
    // El actor es la key, no una persona: `apikey:<id>`.
    expect(String(r.rows[0].actor)).toMatch(/^apikey:/);
  });

  it('sin credencial no se entra, y el método desconocido se dice', async () => {
    const res = await fetch(`${base}/v1/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);

    const key = await crearKey(['agents.use']);
    const { cuerpo } = await rpc(key, 'resources/list');
    expect(cuerpo.error.code).toBe(-32601);
  });

  it('una key sin agents.use no entra al MCP', async () => {
    // El MCP es opt-in por key: se le da a la que va a manejar el asistente,
    // no a la que solo lee contactos para un ERP.
    const key = await crearKey(['crm.contacts.read']);
    const res = await fetch(`${base}/v1/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  });
});
