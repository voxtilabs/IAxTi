import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urlDeLaApp } from './url-de-la-app';
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
  base = urlDeLaApp(app);
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


describe('los ajustes de IA del negocio se pueden escribir (#536)', () => {
  /**
   * `settings.ia` se LEÍA en `iaSettings` desde el principio y ninguna ruta lo
   * escribía: la única escritura del repo era un `UPDATE` crudo en este mismo
   * archivo, unas líneas más arriba. Por eso mi prueba de #494 —«el negocio que
   * pidió solo Gemini recibe un asistente en Gemini»— pasaba: la escribía ella
   * misma con SQL.
   *
   * O sea que el resguardo de ADR-0025 §7 estaba implementado y era
   * inalcanzable: a un cliente que exige por escrito un único proveedor solo se
   * le podía dar con un UPDATE a mano en producción. Y el ADR declara el
   * problema resuelto, así que nadie iba a ir a revisarlo.
   */
  /**
   * Las DOS ramas corren, y antes solo corría una (#838).
   *
   * Esto era un `if (disponibles.disponibles.includes('google'))`, y
   * `providerAvailable` pregunta por `GOOGLE_GENERATIVE_AI_API_KEY` en el
   * entorno. En CI no hay llaves de proveedor, así que `disponibles` llegaba
   * vacío y **siempre corría el `else`**: el 400. La rama que comprueba que el
   * PUT guarda `soloProveedor` —la capacidad que #494 vino a dar— no se
   * ejecutaba nunca.
   *
   * Y la segunda mitad del título, «el asistente nuevo nace ahí», no se
   * probaba en ninguna rama: la prueba no creaba ningún asistente.
   *
   * La llave se pone acá, de mentira: lo que se mide es que la ruta GUARDE la
   * elección, no que el proveedor conteste. Nadie llama al modelo en esta
   * prueba.
   */
  it('sin la llave del proveedor, elegirlo se rechaza diciendo qué pasaría', async () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const antes = await (await pedir(duena, '/agents/ajustes')).json();
    expect(antes.disponibles).not.toContain('google');
    expect(antes.soloProveedor).toBeNull();

    const r = await pedir(duena, '/agents/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ soloProveedor: 'google' }),
    });
    expect(r.status).toBe(400);
    const cuerpo = await r.json();
    expect(cuerpo.code).toBe('PROVIDER_UNAVAILABLE');
    // Y dice qué pasaría, no un «no disponible» a secas.
    expect(cuerpo.message).toContain('dejaría de contestar');
  });

  /**
   * Lo que se MUESTRA es lo efectivo, no lo elegido (#858).
   *
   * Es la diferencia que el cliente no puede deducir: pidió «solo Gemini» y
   * sus notas de voz llegan transcritas igual —porque la transcripción no
   * puede ir a un proveedor de solo texto—, o eligió uno que en este ambiente
   * no tiene credencial y el producto está usando otro para que su negocio no
   * deje de responder. Las dos cosas son correctas y ninguna se anuncia sola.
   */
  it('`atendiendo` dice con qué se atiende de verdad, no lo que el negocio eligió', async () => {
    /**
     * El ambiente se arma para que lo ELEGIDO y lo EFECTIVO no coincidan, que
     * es lo único que prueba algo acá.
     *
     * Sin llave de OpenAI y con la de Google, el defecto compilado de
     * `sugerir` —OpenAI— no se puede usar y el producto cae a Google para que
     * el negocio no deje de responder. Si esta ruta devolviera lo elegido en
     * vez de lo efectivo, diría «openai» y el cliente miraría una pantalla que
     * no describe su producto.
     *
     * La primera versión de esta prueba no distinguía las dos cosas: afirmaba
     * `openai`, que es lo que da por los dos caminos. Pasaba con la
     * implementación correcta y con la equivocada.
     */
    delete process.env.OPENAI_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'llave-de-prueba-no-se-llama-a-nadie';
    try {
      const r = await (await pedir(duena, '/agents/ajustes')).json();
      expect(Object.keys(r.atendiendo).length).toBeGreaterThanOrEqual(9);
      expect(r.atendiendo.sugerir.provider).toBe('google');
      // Y el modelo acompaña al proveedor: quedarse con el de OpenAI
      // apuntando a Google sería un 404 en cada llamada.
      expect(r.atendiendo.sugerir.model).not.toContain('gpt');
    } finally {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    }
  });

  it('con la llave, el dueño elige proveedor único por la ruta y queda guardado', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'llave-de-prueba-no-se-llama-a-nadie';
    try {
      const disponibles = await (await pedir(duena, '/agents/ajustes')).json();
      expect(disponibles.disponibles).toContain('google');

      const r = await pedir(duena, '/agents/ajustes', {
        method: 'PUT',
        body: JSON.stringify({ soloProveedor: 'google' }),
      });
      expect(r.status, `respondió ${r.status}: ${JSON.stringify(await r.clone().json())}`).toBe(200);
      expect((await r.json()).soloProveedor).toBe('google');

      // Y QUEDA guardado: que el PUT lo devuelva en su respuesta no prueba que
      // lo haya persistido. Ésta es la aserción que no existía.
      const releido = await (await pedir(duena, '/agents/ajustes')).json();
      expect(releido.soloProveedor).toBe('google');
    } finally {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      await pedir(duena, '/agents/ajustes', {
        method: 'PUT',
        body: JSON.stringify({ soloProveedor: null }),
      });
    }
  });

  it('un proveedor inventado se rechaza con los que existen', async () => {
    /**
     * El centinela era `'openai'`, y dejó de servir cuando OpenAI pasó a ser
     * un proveedor de verdad (#842): el rechazo cambió de «tiene que ser uno
     * de: …» a «en este ambiente no hay llave para openai», que es otra puerta.
     *
     * Vale anotarlo porque es una forma de envejecer que no se ve venir: un
     * centinela deja de ser centinela cuando el producto crece hacia él. El de
     * ahora es un proveedor que el producto no tiene ni planea tener.
     */
    const r = await pedir(duena, '/agents/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ soloProveedor: 'mistral' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain('uno de:');
  });

  it('guardar el proveedor no pisa las perillas que la pantalla no muestra', async () => {
    // `updateTenantSettings` hace `settings || patch`, merge de PRIMER nivel:
    // escribir `{ ia: { soloProveedor } }` a secas se llevaría `tasks` y
    // `economico`, que un negocio puede tener puestas y esta pantalla no toca.
    await admin.query(
      `UPDATE tenants SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{ia}', '{"economico":{"provider":"glm","model":"z-ai/glm-5.3-flash"}}'::jsonb) WHERE id = $1`,
      [tenant],
    );
    const r = await pedir(duena, '/agents/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ soloProveedor: null, redactPII: false }),
    });
    expect(r.status).toBe(200);
    const fila = await admin.query('SELECT settings FROM tenants WHERE id = $1', [tenant]);
    const ia = (fila.rows[0].settings as { ia: Record<string, unknown> }).ia;
    expect(ia.economico, 'se llevó el modelo económico').toBeTruthy();
    expect(ia.redactPII).toBe(false);
    expect(ia).not.toHaveProperty('soloProveedor');
  });

  it('el vendedor no toca los ajustes de IA del negocio', async () => {
    const r = await pedir(vendedor, '/agents/ajustes', {
      method: 'PUT',
      body: JSON.stringify({ soloProveedor: null }),
    });
    expect(r.status).toBe(403);
  });
});

/**
 * El PUT del asistente valida lo que recibe (#1232).
 *
 * Lo que había antes era `@Body() body: Partial<AgentInput> & { active?: boolean }`:
 * una declaración de TypeScript, que no comprueba nada en ejecución. El
 * resultado medido no era un 500 ni un dato corrupto —habría sido más fácil—,
 * era SILENCIO: `confidence_threshold: 5` se guardaba, la pantalla mostraba 5 y
 * la IA seguía escalando con 0,7 porque `guardrailLimits` descarta lo que no
 * esté en (0, 1]. El dueño configuró una cosa y el producto hizo otra, sin un
 * aviso en ninguna parte.
 *
 * Por eso cada prueba de acá comprueba DOS cosas y no una: que la respuesta sea
 * un 400 que dice qué pasó, y que la base NO tenga el valor. Solo con el status
 * pasarían igual si el valor se guardara de todas formas.
 */
describe('el asistente no se come un valor inválido (#1232)', () => {
  let asistente: string;

  beforeAll(async () => {
    const r = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Guardarrieles' }),
    });
    asistente = ((await r.json()) as { id: string }).id;
  });

  const editar = (cuerpo: unknown) =>
    pedir(duena, `/agents/${asistente}`, { method: 'PUT', body: JSON.stringify(cuerpo) });

  const guardado = async (columna: 'limits' | 'autonomous_hours') => {
    const f = await admin.query(`SELECT ${columna} AS v FROM agents WHERE id = $1`, [asistente]);
    return f.rows[0].v as Record<string, unknown>;
  };

  it('un valor fuera de rango es un 400 que dice el rango, y no se guarda', async () => {
    const r = await editar({ limits: { confidence_threshold: 5 } });
    expect(r.status).toBe(400);
    const cuerpo = (await r.json()) as { code: string; message: string; details: unknown[] };
    expect(cuerpo.code).toBe('VALIDATION_ERROR');
    // El rango, escrito: «fuera de rango» a secas no le dice a nadie qué poner.
    expect(cuerpo.message).toContain('entre 0 y 1');
    expect(cuerpo.details).toContainEqual(
      expect.objectContaining({ field: 'limits.confidence_threshold' }),
    );
    expect(await guardado('limits')).not.toHaveProperty('confidence_threshold');
  });

  it('una llave que nadie lee se rechaza nombrándola, y nombrando las que sí valen', async () => {
    // `max_executions_day` es la del comentario de la migración de
    // `agents.limits`: está nombrada ahí desde el primer día y ningún lector la
    // mira. Era exactamente lo que se guardaba sin hacer nada.
    const r = await editar({ limits: { max_executions_day: 10 } });
    expect(r.status).toBe(400);
    const cuerpo = (await r.json()) as { code: string; message: string };
    expect(cuerpo.code).toBe('VALIDATION_ERROR');
    expect(cuerpo.message).toContain('max_executions_day');
    expect(cuerpo.message).toContain('confidence_threshold');
    expect(await guardado('limits')).not.toHaveProperty('max_executions_day');
  });

  it('los valores válidos se guardan, y el tope de dinero se puede limpiar', async () => {
    const puesto = await editar({
      limits: {
        confidence_threshold: 0.85,
        max_agent_turns: 3,
        money_limit_clp: 50_000,
        // En blanco significa «usa el texto por defecto» (`avisoDeEscalada`), así
        // que el esquema lo acepta: rechazarlo quitaría una forma de borrarlo.
        escalation_notice: '   ',
      },
    });
    expect(puesto.status).toBe(200);
    expect(await guardado('limits')).toEqual({
      confidence_threshold: 0.85,
      max_agent_turns: 3,
      money_limit_clp: 50_000,
      escalation_notice: '   ',
    });

    // Limpiar el tope es omitir la llave, que es lo que manda la pantalla
    // cuando el campo queda vacío (`JSON.stringify` borra los `undefined`).
    const limpio = await editar({ limits: { confidence_threshold: 0.85, max_agent_turns: 3 } });
    expect(limpio.status).toBe(200);
    expect(await guardado('limits')).not.toHaveProperty('money_limit_clp');
  });

  it('el 0 en el tope de dinero no pasa en silencio: dice cómo dejarlo sin tope', async () => {
    // `guardrailLimits` convierte el 0 en «sin tope», que es lo CONTRARIO de lo
    // que escribe quien pone 0 esperando que escale por cualquier peso.
    const r = await editar({ limits: { money_limit_clp: 0 } });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain('en blanco');
  });

  it('el pulso a medio configurar no queda prendido y mudo', async () => {
    // Sin `hasta`, `configDelPulso` devuelve null: el pulso se ve prendido en la
    // configuración y no manda nunca. Es la función que más rápido puede costar
    // un número de WhatsApp, así que acá el silencio no se admite.
    const aMedias = await editar({ limits: { pulso: { activo: true, desde: '08:30' } } });
    expect(aMedias.status).toBe(400);

    const insistente = await editar({
      limits: { pulso: { activo: true, desde: '08:30', hasta: '18:00', max_por_persona: 20 } },
    });
    expect(insistente.status).toBe(400);
    expect((await insistente.json()).message).toContain('de 1 a 12');

    const bueno = await editar({
      limits: { pulso: { activo: true, desde: '08:30', hasta: '18:00', cada_minutos: 40 } },
    });
    expect(bueno.status).toBe(200);
    expect(await guardado('limits')).toEqual({
      pulso: { activo: true, desde: '08:30', hasta: '18:00', cada_minutos: 40 },
    });
  });

  it('guardar un guardarriel no se lleva el pulso que esta pantalla no muestra', async () => {
    // El PUT reemplaza `limits` completo, así que la pantalla reenvía lo que no
    // toca. Que el esquema CONOZCA `pulso` es lo que lo hace posible: si lo
    // rechazara, reenviarlo dejaría la pantalla sin poder guardar.
    const r = await editar({
      limits: {
        pulso: { activo: true, desde: '08:30', hasta: '18:00', cada_minutos: 40 },
        confidence_threshold: 0.6,
      },
    });
    expect(r.status).toBe(200);
    const limites = await guardado('limits');
    expect(limites.pulso).toEqual({
      activo: true,
      desde: '08:30',
      hasta: '18:00',
      cada_minutos: 40,
    });
    expect(limites.confidence_threshold).toBe(0.6);
  });

  it('el horario autónomo necesita las dos horas, y al menos un día', async () => {
    const media = await editar({ autonomousHours: { start: '19:00' } });
    expect(media.status).toBe(400);
    expect((await media.json()).message).toContain('las dos horas');

    // `inAutonomousHours` compara los horarios como TEXTO: `7pm` no es una hora
    // y `7:00` sin cero adelante queda mayor que `19:00`.
    const sinFormato = await editar({ autonomousHours: { start: '7pm', end: '09:00' } });
    expect(sinFormato.status).toBe(400);

    const sinDias = await editar({ autonomousHours: { start: '19:00', end: '09:00', days: [] } });
    expect(sinDias.status).toBe(400);
    expect((await sinDias.json()).message).toContain('al menos un día');

    // Vacío sigue siendo válido: es el «nunca sola» con que nace un asistente.
    expect((await editar({ autonomousHours: {} })).status).toBe(200);

    const bueno = await editar({ autonomousHours: { start: '19:00', end: '09:00', days: [1, 2] } });
    expect(bueno.status).toBe(200);
    expect(await guardado('autonomous_hours')).toEqual({
      start: '19:00',
      end: '09:00',
      days: [1, 2],
    });
  });

  it('un campo que el asistente no tiene se rechaza al crear, y no crea nada', async () => {
    const antes = (await (await pedir(duena, '/agents')).json()).length;
    const r = await pedir(duena, '/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Inventado', temperatura: 0.9 }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain('temperatura');
    expect((await (await pedir(duena, '/agents')).json()).length).toBe(antes);
  });
});
