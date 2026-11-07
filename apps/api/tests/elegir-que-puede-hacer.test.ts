import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';
import { urlDeLaApp } from './url-de-la-app';

/**
 * Elegir qué puede hacer el asistente (#1285).
 *
 * `allowedToolsFor()` hacía la unión de lo configurado con lo del objetivo
 * desde #315, y no había forma de configurar nada: `allowed_tools` nacía
 * vacío y sin pantalla.
 *
 * Lo que esta prueba cuida NO es la pantalla: es que la ruta no sea una puerta
 * trasera. La pantalla filtra por destinatario, pero una llave de API entra
 * por el mismo `PUT` sin pasar por ninguna pantalla, y un
 * `allowedTools: ['analytics.metrica']` sobre un asistente de WhatsApp le
 * colgaría las cifras del negocio a un bot que habla con clientes — el
 * agujero exacto que la #410 cerró por el lado del asistente.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID();

async function pedir(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(duena)}`,
      'X-Tenant-Id': tenant,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** Crea un asistente con ese objetivo y devuelve su id. */
async function asistente(nombre: string, objetivo: string): Promise<string> {
  const r = await pedir('/agents', { method: 'POST', body: JSON.stringify({ name: nombre, objetivo }) });
  // El cuerpo se lee UNA vez: `await r.text()` dentro del mensaje del expect
  // lo consume, y el `r.json()` de después falla con «Body has already been
  // read» — que no habla del defecto, habla de la prueba.
  const cuerpo = await r.text();
  expect(r.status, cuerpo).toBe(201);
  return (JSON.parse(cuerpo) as { id: string }).id;
}

type Fila = {
  nombre: string;
  rotulo: string;
  escribe: boolean;
  obligatoria: boolean;
  marcada: boolean;
  disponible: boolean;
};

async function catalogo(id: string) {
  const r = await pedir(`/agents/${id}/herramientas`);
  const cuerpo = await r.text();
  expect(r.status, cuerpo).toBe(200);
  return JSON.parse(cuerpo) as { destinatario: string; herramientas: Fila[] };
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('que-puede-hacer') RETURNING id"))
    .rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'duena@quepuede.cl', roleName: 'ADMIN' }),
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
  });
  await app.listen(0);
  base = urlDeLaApp(app);
});

afterAll(async () => {
  await app?.close();
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin?.end();
});

describe('elegir qué puede hacer el asistente (#1285)', () => {
  it('el catálogo llega con rótulos en castellano, no con nombres técnicos', async () => {
    const id = await asistente('Agenda', 'agendar');
    const { destinatario, herramientas } = await catalogo(id);
    expect(destinatario).toBe('cliente');
    expect(herramientas.length).toBeGreaterThan(0);
    for (const h of herramientas) {
      expect(h.rotulo, h.nombre).not.toContain('.');
      expect(h.rotulo.split(/\s+/).length, h.nombre).toBeGreaterThan(2);
    }
  });

  it('las que exige el objetivo vienen marcadas y señaladas como obligatorias', async () => {
    const id = await asistente('Agenda 2', 'agendar');
    const { herramientas } = await catalogo(id);
    const slots = herramientas.find((h) => h.nombre === 'calendar.get_slots');
    expect(slots?.obligatoria, 'agendar sin ver horarios prometería horas que no puede ver').toBe(true);
    expect(slots?.marcada).toBe(true);
    // Y una que NO exige el objetivo llega sin marcar: es lo que el dueño puede sumar.
    const nota = herramientas.find((h) => h.nombre === 'crm.create_activity');
    expect(nota?.obligatoria).toBe(false);
    expect(nota?.marcada).toBe(false);
  });

  it('a un asistente que atiende CLIENTES no se le ofrecen las cifras del negocio (#410)', async () => {
    const id = await asistente('Agenda 3', 'agendar');
    const { herramientas } = await catalogo(id);
    expect(herramientas.map((h) => h.nombre).filter((n) => n.startsWith('analytics.'))).toEqual([]);
  });

  it('y al asistente del DUEÑO no se le ofrece tomar ni mover horas de clientes', async () => {
    const id = await asistente('Cifras', 'estadisticas');
    const { destinatario, herramientas } = await catalogo(id);
    expect(destinatario).toBe('dueño');
    const nombres = herramientas.map((h) => h.nombre);
    expect(nombres).not.toContain('calendar.book');
    expect(nombres).not.toContain('calendar.reschedule');
  });

  it('el dueño le puede sumar una herramienta, y queda guardada', async () => {
    const id = await asistente('Agenda 4', 'agendar');
    const r = await pedir(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ allowedTools: ['crm.create_activity'] }),
    });
    expect(r.status, await r.text()).toBe(200);
    const { herramientas } = await catalogo(id);
    expect(herramientas.find((h) => h.nombre === 'crm.create_activity')?.marcada).toBe(true);
  });

  /**
   * La puerta trasera, cerrada. Esto es lo único de este PR que podía salir
   * caro, así que no se asume: se comprueba por la ruta, que es por donde
   * entra una llave de API sin ver ninguna pantalla.
   */
  it('la ruta RECHAZA darle las cifras del negocio a un asistente de clientes', async () => {
    const id = await asistente('Agenda 5', 'agendar');
    const r = await pedir(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ allowedTools: ['analytics.metrica'] }),
    });
    expect(r.status).toBe(400);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe('AGENT_TOOL_INVALID');
    // El mensaje llega entero: sin la línea que no lo reenvuelve, acá venía
    // `AGENT_INVALID` con el message en `undefined`.
    expect(cuerpo.message).toContain('analytics.metrica');
    expect(cuerpo.message).toMatch(/cifras del negocio/i);
  });

  it('y rechaza una herramienta que no existe, en vez de guardarla en silencio', async () => {
    const id = await asistente('Agenda 6', 'agendar');
    const r = await pedir(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ allowedTools: ['crm.borrar_todo'] }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toContain('crm.borrar_todo');
  });

  it('si el objetivo cambia en el MISMO cuerpo, manda el nuevo', async () => {
    // Un asistente de clientes que pasa a ser del dueño y en la misma
    // llamada recibe una herramienta de analytics: validar contra el objetivo
    // viejo rechazaría una configuración legítima.
    const id = await asistente('Agenda 7', 'agendar');
    const r = await pedir(`/agents/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ objetivo: 'estadisticas', allowedTools: ['analytics.metrica'] }),
    });
    expect(r.status, await r.text()).toBe(200);
  });
});
