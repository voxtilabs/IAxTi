import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { apagarAgenteGeneral, encenderAgenteGeneral } from '@iaxti/module-platform';
import { CATALOGO } from '@iaxti/module-agents';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

/**
 * `/v1/agente-general` (#511, ADR-0025).
 *
 * La prueba del runtime vive en el módulo y cubre las tres reglas con un
 * modelo falso. Esto cubre lo que está EN LA RUTA y no en el runtime, que es
 * justo donde se juntan las tres capas que se declaran por separado:
 *
 *  1. El interruptor (#496): apagarlo apaga las DOS puertas.
 *  2. Los permisos salen de `permisosDelActor`, que es código de la ruta —
 *     el runtime recibe el Set ya armado.
 *  3. `aplicar` revalida lo que trae el navegador, y después la ruta de
 *     verdad lo verifica por su cuenta.
 *
 * Nada de esto necesita al proveedor: `aplicarPropuesta` no usa el modelo, y
 * el interruptor se revisa ANTES de pedirlo. Por eso se puede probar la parte
 * caliente sin pagarle a nadie en CI.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
// Quien apaga es un SuperAdmin de la plataforma, y la columna es uuid.
const SOPORTE = randomUUID();
const vendedor = randomUUID(); // USER

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

const conversar = (quien: string, cuerpo: unknown) =>
  pedir(quien, '/agente-general', { method: 'POST', body: JSON.stringify(cuerpo) });

const aplicar = (quien: string, cuerpo: unknown) =>
  pedir(quien, '/agente-general/aplicar', { method: 'POST', body: JSON.stringify(cuerpo) });

const UNA_PREGUNTA = { turnos: [{ role: 'user', content: 'agrega un contacto' }] };

/** Las que esta prueba nombra. Hay un test que comprueba que existan. */
const HERRAMIENTAS_QUE_USA = ['contacts.crear', 'equipoUsuarios.invitar'] as const;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-agente-general') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'duena@ag.cl', 'ADMIN'],
    [vendedor, 'vende@ag.cl', 'USER'],
  ] as const) {
    const inv = await withTenant(admin, tenant, (c) =>
      createInvitation(c, { tenantId: tenant, email, roleName }),
    );
    await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId }));
  }

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

afterEach(async () => {
  // Que un test no le deje el agente apagado al siguiente.
  await encenderAgenteGeneral(admin, { tenantId: tenant, adminUser: SOPORTE }).catch(() => {});
  await encenderAgenteGeneral(admin, { tenantId: null, adminUser: SOPORTE }).catch(() => {});
});

afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM agente_general_apagado WHERE tenant_id = $1 OR tenant_id IS NULL', [tenant]);
  await admin.query('DELETE FROM agent_general_runs WHERE tenant_id = $1', [tenant]).catch(() => {});
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

describe('las herramientas que nombra esta prueba existen', () => {
  it('ninguna es inventada', () => {
    // Escribí `equipo.invitar` de memoria y el test pasaba: se rechazaba por
    // inexistente, no por permiso. O sea, la prueba del permiso no probaba el
    // permiso. Como las pruebas no pasan por el typecheck (#507), un nombre
    // equivocado no lo caza nadie — salvo esto.
    const existen = new Set(CATALOGO.map((h) => h.nombre));
    for (const nombre of HERRAMIENTAS_QUE_USA) {
      expect(existen.has(nombre), `${nombre} no está en el catálogo`).toBe(true);
    }
  });
});

describe('la puerta de conversar', () => {
  it('sin lo que preguntar, 400 — y el último turno tiene que ser de quien pregunta', async () => {
    expect((await conversar(duena, {})).status).toBe(400);
    expect((await conversar(duena, { turnos: [] })).status).toBe(400);
    // Un hilo que termina en la respuesta del agente no es una pregunta: si
    // pasara, el modelo contestaría a su propia respuesta.
    const alReves = await conversar(duena, {
      turnos: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hola, dime' },
      ],
    });
    expect(alReves.status).toBe(400);
  });

  it('en este ambiente no hay llave: avisa claro, no adivina', async () => {
    // El 503 con nombre es el contrato de #402: sin llave se dice cuál falta,
    // jamás se cae a un tier gratis ni se inventa una respuesta.
    const r = await conversar(duena, UNA_PREGUNTA);
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('el interruptor apaga las DOS puertas (#496)', () => {
  it('apagado para este negocio: 409 con el motivo, al conversar y al aplicar', async () => {
    await apagarAgenteGeneral(admin, {
      tenantId: tenant,
      motivo: 'Incidente con el proveedor',
      adminUser: SOPORTE,
    });

    const hablar = await conversar(duena, UNA_PREGUNTA);
    expect(hablar.status).toBe(409);
    const cuerpo = await hablar.json();
    expect(cuerpo.code).toBe('AGENTE_GENERAL_APAGADO');
    // Dice QUE está apagado y que las pantallas siguen. Lo que NO dice es el
    // motivo que escribió el SuperAdmin: ese es una nota interna de un
    // incidente y puede nombrar al proveedor, una cuenta o una deuda. Un
    // dueño de pyme no tiene por qué leer eso, y el día que alguien crea que
    // "falta el motivo" y lo agregue, este expect es el que lo detiene.
    expect(cuerpo.message).toContain('desactivada en esta cuenta');
    expect(JSON.stringify(cuerpo)).not.toContain('Incidente con el proveedor');

    // Y la otra puerta también. Apagarlo con una propuesta ya en pantalla no
    // puede dejar un botón que igual funciona.
    const aplicando = await aplicar(duena, { herramienta: 'contacts.crear', argumentos: { name: 'X' } });
    expect(aplicando.status).toBe(409);
  });

  it('apagado global: tampoco pasa, aunque este negocio no esté apagado', async () => {
    await apagarAgenteGeneral(admin, {
      tenantId: null,
      motivo: 'Mantención de la plataforma',
      adminUser: SOPORTE,
    });
    const r = await conversar(duena, UNA_PREGUNTA);
    expect(r.status).toBe(409);
    const cuerpo = await r.json();
    // Y el mensaje es OTRO: apagado por mantención de la plataforma no es lo
    // mismo que desactivado en esta cuenta, y quien lee decide distinto
    // (esperar, o escribirnos).
    expect(cuerpo.message).toContain('mantención');
    expect(JSON.stringify(cuerpo)).not.toContain('Mantención de la plataforma');
  });

  it('encendido de nuevo, vuelve a atender', async () => {
    await apagarAgenteGeneral(admin, { tenantId: tenant, motivo: 'prueba', adminUser: SOPORTE });
    expect((await conversar(duena, UNA_PREGUNTA)).status).toBe(409);
    await encenderAgenteGeneral(admin, { tenantId: tenant, adminUser: SOPORTE });
    // 503 y no 409: ya no está apagado, lo que falta es la llave.
    expect((await conversar(duena, UNA_PREGUNTA)).status).toBe(503);
  });
});

describe('aplicar no confía en lo que trae el navegador', () => {
  it('sin decir qué aplicar, 400', async () => {
    expect((await aplicar(duena, {})).status).toBe(400);
    expect((await aplicar(duena, { argumentos: { name: 'X' } })).status).toBe(400);
  });

  it('una herramienta inventada se rechaza acá, no llega a ninguna ruta', async () => {
    const r = await aplicar(duena, { herramienta: 'no.existe', argumentos: {} });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('ACCION_RECHAZADA');
  });

  it('el USER no aplica lo que su rol no permite, aunque mande la herramienta a mano', async () => {
    // Es el caso que justifica las dos capas. La propuesta viaja por el
    // navegador: cualquiera con una sesión puede cambiarla y mandar la
    // herramienta que quiera. Si esto pasara, el Agente General sería una
    // forma de saltarse los permisos del producto — con las 195 herramientas
    // detrás.
    const r = await aplicar(vendedor, {
      // El nombre REAL del catálogo. Con uno inventado el test pasaría igual
      // —se rechaza por inexistente— y no habría probado nada del permiso.
      herramienta: 'equipoUsuarios.invitar',
      argumentos: { email: 'colado@ajeno.cl', roleName: 'ADMIN' },
    });
    expect(r.status).toBe(400);

    // Y no invitó a nadie: el rechazo no es solo del código de estado.
    const invitados = await admin.query(
      'SELECT count(*)::int AS n FROM invitations WHERE tenant_id = $1 AND email = $2',
      [tenant, 'colado@ajeno.cl'],
    );
    expect(invitados.rows[0].n).toBe(0);
  });

  it('un tenant ajeno en la cabecera no abre la puerta', async () => {
    // El aislamiento no depende de que el agente se porte bien.
    const otro = (await admin.query("INSERT INTO tenants (name) VALUES ('ajeno-ag') RETURNING id"))
      .rows[0].id;
    const r = await fetch(`${base}/v1/agente-general/aplicar`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await firmar(duena)}`,
        'X-Tenant-Id': otro,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ herramienta: 'contacts.crear', argumentos: { name: 'X' } }),
    });
    expect([401, 403, 404]).toContain(r.status);
    await admin.query('DELETE FROM tenants WHERE id = $1', [otro]);
  });
});
