import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { DEFAULT_TASK_MODELS } from '@iaxti/module-agents';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API del runtime (#47): permisos §23 y el aviso claro sin llaves.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const duena = randomUUID(); // ADMIN
const supervisora = randomUUID(); // SUPERVISOR
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

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? ADMIN_URL;
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-agents') RETURNING id");
  tenant = t.rows[0].id;
  for (const [userId, email, roleName] of [
    [duena, 'dueña@agents.cl', 'ADMIN'],
    [supervisora, 'sup@agents.cl', 'SUPERVISOR'],
    [vendedor, 'vende@agents.cl', 'USER'],
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

afterAll(async () => {
  await app.close();
  await admin.query('DELETE FROM eval_runs WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM eval_cases WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agent_proposals WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agent_executions WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM agents WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.end();
});

describe('/v1/agents (#47)', () => {
  it('configurar es del ADMIN (§23); el USER ve pero no crea', async () => {
    const negado = await pedir(vendedor, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sofía' }),
    });
    expect(negado.status).toBe(403);

    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.' }),
    });
    expect(creado.status).toBe(201);
    const agente = await creado.json();
    // Nace en el proveedor que el producto usa para sugerir, no en uno fijo en
    // el SQL: desde ADR-0025 eso es GLM y el Agente General crea asistentes.
    expect(agente.provider).toBe(DEFAULT_TASK_MODELS.sugerir.provider);

    const lista = await (await pedir(vendedor, '/agents')).json();
    expect(lista.map((a: { name: string }) => a.name)).toContain('Sofía');
  });

  it('cambiar de modelo es un PUT, no un deploy; proveedor pirata 400', async () => {
    const [agente] = await (await pedir(duena, '/agents')).json();
    const editado = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'glm', model: 'glm-4.6' }),
    });
    expect(editado.status).toBe(200);
    expect((await editado.json()).model).toBe('glm-4.6');

    const pirata = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'pirata' }),
    });
    expect(pirata.status).toBe(400);
  });

  it('sin llave del proveedor, correr avisa claro (503) — jamás tier gratis', async () => {
    const [agente] = await (await pedir(duena, '/agents')).json();
    const res = await pedir(vendedor, `/agents/${agente.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ task: 'sugerir', prompt: 'hola' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('el configurador (#50) es del ADMIN; sin llave avisa claro; sin texto 400', async () => {
    const negado = await pedir(vendedor, '/agents/configurador', {
      method: 'POST',
      body: JSON.stringify({ description: 'Barbería en Ñuñoa', vertical: 'belleza' }),
    });
    expect(negado.status).toBe(403);

    const sinTexto = await pedir(duena, '/agents/configurador', {
      method: 'POST',
      body: JSON.stringify({ vertical: 'belleza' }),
    });
    expect(sinTexto.status).toBe(400);

    // En este ambiente no hay llaves de proveedor: avisa, no adivina.
    const sinLlave = await pedir(duena, '/agents/configurador', {
      method: 'POST',
      body: JSON.stringify({ description: 'Barbería en Ñuñoa, 3 barberos', vertical: 'belleza' }),
    });
    expect(sinLlave.status).toBe(503);
    expect((await sinLlave.json()).code).toBe('PROVIDER_UNAVAILABLE');

    // Sin propuesta pendiente, el GET devuelve vacío (200).
    expect((await pedir(duena, '/agents/configurador')).status).toBe(200);
  });

  it('el consumo es de supervisión (§23): USER 403, SUPERVISORA 200', async () => {
    expect((await pedir(vendedor, '/agents/executions')).status).toBe(403);
    const res = await pedir(supervisora, '/agents/executions');
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('el gate de evaluación (#53) bloquea pasar a una config que rinde peor', async () => {
    const [agente] = await (await pedir(duena, '/agents')).json();
    // Evidencia: la config vigente (glm-4.6) evaluada 0.9; la candidata 0.4.
    for (const [provider, model, score] of [
      ['glm', 'glm-4.6', 0.9],
      ['google', 'gemini-2.5-flash', 0.4],
    ] as const) {
      await admin.query(
        `INSERT INTO eval_runs (tenant_id, agent_id, provider, model, prompt_version, case_count, scores, score)
         VALUES ($1, $2, $3, $4, NULL, 1, '[]', $5)`,
        [tenant, agente.id, provider, model, score],
      );
    }
    const bloqueado = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'google', model: 'gemini-2.5-flash' }),
    });
    expect(bloqueado.status).toBe(409);
    expect((await bloqueado.json()).code).toBe('EVAL_REGRESSION');

    // Sin evidencia de la candidata, el cambio pasa (no hay con qué comparar).
    const pasa = await pedir(duena, `/agents/${agente.id}`, {
      method: 'PUT',
      body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5' }),
    });
    expect(pasa.status).toBe(200);

    // Sin evaluar aún, el endpoint avisa que faltan casos.
    const sinCasos = await pedir(duena, `/agents/${agente.id}/evaluate`, { method: 'POST' });
    expect(sinCasos.status).toBe(503); // sin llave: primero avisa el proveedor
    expect((await pedir(vendedor, `/agents/${agente.id}/evals`)).status).toBe(403);
    expect((await pedir(supervisora, `/agents/${agente.id}/evals`)).status).toBe(200);
  });

  it('el catálogo de objetivos dice cuáles puede usar este negocio (#385)', async () => {
    // La pantalla que crea el asistente se dibuja con esto. Si los
    // objetivos vinieran de una constante del frontend, se
    // desincronizarían con `DEFINICIONES` y nadie se enteraría hasta que
    // alguien eligiera uno que el servidor ya no acepta.
    const res = await pedir(duena, '/agents/objetivos');
    expect(res.status).toBe(200);
    const objetivos = (await res.json()) as Array<{
      id: string;
      titulo: string;
      requiere: string[];
      faltan: string[];
      disponible: boolean;
      datosMinimos: string[];
      detallePorDefecto: string;
    }>;

    expect(objetivos.length).toBeGreaterThanOrEqual(5);
    const agendar = objetivos.find((o) => o.id === 'agendar')!;
    expect(agendar.titulo).toBeTruthy();
    expect(agendar.requiere).toContain('calendar');
    expect(agendar.datosMinimos.length).toBeGreaterThan(0);
    expect(agendar.detallePorDefecto).toBeTruthy();

    // `disponible` es consecuencia de `faltan`, no un campo suelto: si se
    // calcularan por separado podrían contradecirse.
    for (const o of objetivos) {
      expect(o.disponible).toBe(o.faltan.length === 0);
      for (const m of o.faltan) expect(o.requiere).toContain(m);
    }

    // La instrucción es el prompt del sistema y NO se expone: mostrarla
    // invita a editarla desde la pantalla, y ahí deja de ser una decisión
    // del producto.
    expect(JSON.stringify(objetivos)).not.toContain('Tu objetivo es');
  });

  it('crear el asistente con objetivo es del ADMIN, y nace sugiriendo', async () => {
    expect((await pedir(vendedor, '/agents/objetivos')).status).toBe(403);

    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Asistente de prueba', objetivo: 'informar', objetivoDetalle: 'una respuesta' }),
    });
    expect(creado.status).toBe(201);
    const agente = (await creado.json()) as { objetivo: string; objetivoDetalle: string; defaultMode: string };
    expect(agente.objetivo).toBe('informar');
    expect(agente.objetivoDetalle).toBe('una respuesta');
    // ADR-0010: el copiloto sugiere y el humano envía. Sin pedirlo, el
    // asistente nace en 'assist'.
    expect(agente.defaultMode).toBe('assist');

    const inventado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Otro', objetivo: 'conquistar-el-mundo' }),
    });
    expect(inventado.status).toBe(400);
  });

  // --- Preguntarle a los números (#410) ---

  it('el asistente del CLIENTE no contesta por la puerta del dueño', async () => {
    // Es la mitad del punto del eje `destinatario`: si cualquier asistente
    // contestara acá, uno hecho para vender le improvisaría cifras al dueño
    // sin haber consultado un solo reporte.
    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Vendedora', objetivo: 'vender' }),
    });
    const cliente = await creado.json();

    const res = await pedir(duena, `/agents/${cliente.id}/preguntar`, {
      method: 'POST',
      body: JSON.stringify({ pregunta: '¿cómo vamos?' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('AGENT_NO_ES_DEL_DUENO');
  });

  it('sin pregunta, 400; con pregunta llega hasta el proveedor', async () => {
    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Números', objetivo: 'estadisticas' }),
    });
    expect(creado.status).toBe(201);
    const dueno = await creado.json();
    expect(dueno.objetivo).toBe('estadisticas');

    const vacia = await pedir(duena, `/agents/${dueno.id}/preguntar`, {
      method: 'POST',
      body: JSON.stringify({ pregunta: '   ' }),
    });
    expect(vacia.status).toBe(400);
    expect((await vacia.json()).code).toBe('VALIDATION_ERROR');

    // Sin llave del proveedor en este ambiente, el 503 es la PRUEBA de que
    // pasó todo lo de antes: el objetivo es del dueño, es alcanzable y las
    // herramientas se armaron. Es hasta donde se puede llegar sin llamar a
    // Google de verdad.
    const res = await pedir(duena, `/agents/${dueno.id}/preguntar`, {
      method: 'POST',
      body: JSON.stringify({ pregunta: '¿cuántas conversaciones tuvimos?' }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('el de configuración PROPONE: por la puerta de preguntar se le dice dónde ir', async () => {
    // También es del dueño, pero su salida no es una respuesta: es un diff
    // que se aplica o se descarta (#415). Una respuesta suelta por acá
    // sonaría a que algo quedó configurado.
    const creado = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Armador', objetivo: 'configuracion' }),
    });
    expect(creado.status).toBe(201);
    const armador = await creado.json();

    const res = await pedir(duena, `/agents/${armador.id}/preguntar`, {
      method: 'POST',
      body: JSON.stringify({ pregunta: '¿cómo configuro esto?' }),
    });
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo.code).toBe('AGENT_PROPONE_NO_RESPONDE');
    expect(cuerpo.message).toContain('Ajustes');
  });

  it('el configurador dice QUIÉN arma la propuesta', async () => {
    const r = await pedir(duena, '/agents/configurador/quien');
    expect(r.status).toBe(200);
    const q = await r.json();
    // Se acaba de crear el de configuración: tiene que ser ese, y decir
    // que es uno hecho para esto.
    expect(q.agente?.name).toBe('Armador');
    expect(q.propio).toBe(true);
    expect(q.agente.model).toBeTruthy();
  });

  it('preguntar es de quien usa el asistente, no solo del ADMIN', async () => {
    // El vendedor pregunta y VE LO SUYO: el permiso lo resuelve la misma
    // función que el tablero (ADR-0008), no una regla nueva escrita acá.
    const [numeros] = (await (await pedir(duena, '/agents')).json()).filter(
      (a: { objetivo: string | null }) => a.objetivo === 'estadisticas',
    );
    const res = await pedir(vendedor, `/agents/${numeros.id}/preguntar`, {
      method: 'POST',
      body: JSON.stringify({ pregunta: '¿cómo vamos?' }),
    });
    expect(res.status).not.toBe(403);
  });
});

