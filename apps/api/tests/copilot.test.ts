import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createInvitation, acceptInvitation } from '@iaxti/module-identity';
import { receiveInbound } from '@iaxti/module-conversations';
import { createPipeline } from '@iaxti/module-crm';
import { createAgent, suggestForInbound, type ModelPortFactory, type Suggestion } from '@iaxti/module-agents';
import { createApp } from '../src/main';
import { dbRoleResolver } from '../src/auth/role-resolver';

// La API del copiloto (#48): la sugerencia se entrega, "Enviar" responde con
// UN toque por el MISMO flujo de responder, y crear la oportunidad la decide
// el humano — nunca la IA sola en assist.
const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const ISSUER = 'https://test.supabase.local/auth/v1';

let app: INestApplication;
let base: string;
let admin: Pool;
let tenant: string;
let firmar: (sub: string) => Promise<string>;
const vendedor = randomUUID(); // USER
let conversacion: string;
let contacto: string;

const JSON_SUGERENCIA = `{"sugerencia": "¡Hola! Tenemos horas mañana a las 10:00 — ¿te acomoda?",
"confianza": 0.9, "intencion": "cotizar", "calificacion": "caliente", "crear_oportunidad": true}`;

const fakeFactory: ModelPortFactory = () => ({
  async generate() {
    return { text: JSON_SUGERENCIA, tokensIn: 100, tokensOut: 40 };
  },
});

function sugerir(): Promise<Suggestion | null> {
  return withTenant(admin, tenant, (c) =>
    suggestForInbound(c, { tenantId: tenant, conversationId: conversacion }, fakeFactory),
  );
}

async function pedir(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await firmar(vendedor)}`,
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
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('test-copilot-api') RETURNING id");
  tenant = t.rows[0].id;
  const inv = await withTenant(admin, tenant, (c) =>
    createInvitation(c, { tenantId: tenant, email: 'vende@copilot.cl', roleName: 'USER' }),
  );
  await withTenant(admin, tenant, (c) => acceptInvitation(c, { token: inv.token, userId: vendedor }));

  await withTenant(admin, tenant, (c) =>
    createAgent(c, { tenantId: tenant, name: 'Sofía', fallbackSystemPrompt: 'Eres Sofía.', actor: 'test' }),
  );
  await withTenant(admin, tenant, (c) =>
    createPipeline(c, {
      tenantId: tenant,
      name: 'Ventas',
      stages: [
        { name: 'Nuevo', type: 'open' },
        { name: 'Ganado', type: 'won' },
        { name: 'Perdido', type: 'lost' },
      ],
    }),
  );

  const res = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56977770001',
      channel: 'simulador',
      body: '¿Me cotizas una manicure para mañana?',
    }),
  );
  conversacion = res.conversation.id;
  contacto = res.contact.id;

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
  for (const tabla of ['agent_conversation_modes', 'suggestions', 'agent_executions', 'agents', 'usage_meters', 'deal_stage_history', 'deals', 'stages', 'pipelines', 'assignments', 'messages', 'conversations', 'contacts', 'user_roles', 'invitations', 'outbox']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]);
  }
  // El tenant se queda: audit_log es append-only y lo referencia.
  await admin.end();
});

describe('el copiloto por API (#48)', () => {
  it('la sugerencia vigente llega y "Enviar" responde con UN toque', async () => {
    const sug = (await sugerir())!;
    const viva = await (await pedir(`/conversations/${conversacion}/suggestion`)).json();
    expect(viva.id).toBe(sug.id);
    expect(viva.suggestDeal).toBe(true);

    const enviado = await pedir(`/conversations/${conversacion}/suggestions/${sug.id}/send`, {
      method: 'POST',
    });
    expect(enviado.status).toBe(201);
    const mensaje = await enviado.json();
    expect(mensaje.body).toContain('¿te acomoda?');
    expect(mensaje.deliveryStatus).toBe('sent'); // canal simulador

    // Enviar toma la conversación (mismo flujo de responder) y la marca sent.
    const conv = await admin.query('SELECT owner_id FROM conversations WHERE id = $1', [conversacion]);
    expect(conv.rows[0].owner_id).toBe(vendedor);
    const fila = await admin.query('SELECT status FROM suggestions WHERE id = $1', [sug.id]);
    expect(fila.rows[0].status).toBe('sent');

    // Dos veces no: la sugerencia ya no está vigente.
    const repetido = await pedir(`/conversations/${conversacion}/suggestions/${sug.id}/send`, {
      method: 'POST',
    });
    expect(repetido.status).toBe(400);
    expect((await repetido.json()).code).toBe('SUGGESTION_GONE');
  });

  it('descartar y el feedback 👍/👎 con motivo quedan guardados', async () => {
    const sug = (await sugerir())!;
    const malo = await pedir(`/conversations/${conversacion}/suggestions/${sug.id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback: 'meh' }),
    });
    expect(malo.status).toBe(400);
    expect((await malo.json()).code).toBe('VALIDATION_ERROR');

    const fb = await pedir(`/conversations/${conversacion}/suggestions/${sug.id}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback: 'down', reason: 'muy seca' }),
    });
    expect((await fb.json()).saved).toBe(true);

    const descartada = await pedir(`/conversations/${conversacion}/suggestions/${sug.id}/dismiss`, {
      method: 'POST',
    });
    expect((await descartada.json()).dismissed).toBe(true);
    const fila = await admin.query('SELECT status, feedback, feedback_reason FROM suggestions WHERE id = $1', [sug.id]);
    expect(fila.rows[0]).toEqual({ status: 'dismissed', feedback: 'down', feedback_reason: 'muy seca' });
  });

  it('el análisis para la ficha trae la última lectura de la IA', async () => {
    const analisis = await (await pedir(`/conversations/${conversacion}/analisis`)).json();
    expect(analisis.intent).toBe('cotizar');
    expect(analisis.leadScore).toBe('caliente');
    expect(analisis.acciones.length).toBeGreaterThanOrEqual(2);
  });

  it('el piloto automático por conversación se enciende a mano y se refleja (#49)', async () => {
    const malo = await pedir(`/conversations/${conversacion}/agent-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'turbo' }),
    });
    expect(malo.status).toBe(400);

    const ok = await pedir(`/conversations/${conversacion}/agent-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'autonomous' }),
    });
    expect(ok.status).toBe(201);
    const analisis = await (await pedir(`/conversations/${conversacion}/analisis`)).json();
    expect(analisis.mode).toBe('autonomous');

    // De vuelta a assist: el humano siempre puede retomar el control.
    await pedir(`/conversations/${conversacion}/agent-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'assist' }),
    });
    const despues = await (await pedir(`/conversations/${conversacion}/analisis`)).json();
    expect(despues.mode).toBe('assist');
  });

  it('"Crear la oportunidad" la crea el HUMANO: pipeline por defecto y él de dueño', async () => {
    const sinTitulo = await pedir('/deals', {
      method: 'POST',
      body: JSON.stringify({ contactId: contacto }),
    });
    expect(sinTitulo.status).toBe(400);
    expect((await sinTitulo.json()).code).toBe('VALIDATION_ERROR');

    const creado = await pedir('/deals', {
      method: 'POST',
      body: JSON.stringify({ contactId: contacto, title: 'Manicure — cotización' }),
    });
    expect(creado.status).toBe(201);
    const deal = await creado.json();
    expect(deal.ownerId).toBe(vendedor);
    expect(deal.title).toBe('Manicure — cotización');
    // En assist la IA jamás creó nada sola: hay UNA oportunidad, la del toque.
    const total = await admin.query('SELECT count(*)::int AS n FROM deals WHERE tenant_id = $1', [tenant]);
    expect(total.rows[0].n).toBe(1);
  });
});
