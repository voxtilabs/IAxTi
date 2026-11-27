import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createChannelAccount, setChannelState } from '@iaxti/module-channels';
import { asegurarAdaptadorDeZernio } from '@iaxti/module-whatsapp';
import { processAprender } from '../src/aprender-de-chats';

/**
 * El job que aprende de los chats del negocio (#1406, ADR-0039), contra la
 * base de verdad, con Zernio y el proveedor de IA interceptados en `fetch`.
 *
 * Lo que se prueba es lo que el ADR promete y que ninguna prueba de unidad
 * puede ver:
 * - sin autorización vigente, NINGUNA llamada afuera;
 * - lo que sale al proveedor de IA —el cuerpo HTTP real— no lleva datos de
 *   los clientes;
 * - el texto de los chats no queda en ninguna tabla;
 * - lo aprendido nace POR REVISAR.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const LLAVE = 'ZERNIO_LLAVE_PRUEBA_1406';
/** Datos de un cliente, escritos como de verdad llegan. */
const DEL_CLIENTE = {
  telefono: '9 8765 4321',
  correo: 'camila.rojas@gmail.com',
  rut: '12.345.678-9',
  tarjeta: '4111 1111 1111 1111',
};
/** Un texto que solo existe en los chats: si aparece en la base, se guardó un chat. */
const MARCADOR = 'frase-unica-del-chat-1406';

let admin: Pool;
let tenant: string;
let cuenta: string;
const llamadas: Array<{ url: string; cuerpo: string }> = [];
let estadoDeMeta = 'imported';
const fetchOriginal = globalThis.fetch;

function respuesta(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fetchFalso = (async (entrada: string | URL | Request, init?: RequestInit) => {
  const url = String(entrada instanceof Request ? entrada.url : entrada);
  const cuerpo = init?.body ? String(init.body) : '';
  llamadas.push({ url, cuerpo });
  const u = new URL(url);
  if (u.hostname === 'zernio.test') {
    if (u.pathname.endsWith('/health')) return respuesta({ coexistenceHistorySync: { status: estadoDeMeta } });
    if (u.pathname === '/api/v1/inbox/conversations') {
      return respuesta({ data: [{ id: 'conv-1', isGroup: false }, { id: 'conv-grupo', isGroup: true }] });
    }
    if (u.pathname.includes('/messages')) {
      return respuesta({
        messages: [
          { message: `Hola, soy Camila, ${MARCADOR}. Mi fono ${DEL_CLIENTE.telefono}, correo ${DEL_CLIENTE.correo}`, direction: 'incoming', createdAt: '2026-09-12T10:00:00.000Z' },
          { message: '¿Cuánto vale el corte de mujer?', direction: 'incoming', createdAt: '2026-09-12T10:01:00.000Z' },
          { message: 'El corte de mujer vale $15.000', direction: 'outgoing', createdAt: '2026-09-12T10:02:00.000Z' },
          { message: `Pago con ${DEL_CLIENTE.tarjeta}, rut ${DEL_CLIENTE.rut}`, direction: 'incoming', createdAt: '2026-09-12T10:03:00.000Z' },
        ],
      });
    }
    return new Response('{}', { status: 404 });
  }
  // El proveedor de IA (OpenAI, Responses API): devuelve lo «aprendido».
  const aprendido = JSON.stringify({
    tono: 'Cercano, de tú.',
    entradas: [{ pregunta: '¿Cuánto vale el corte de mujer?', respuesta: 'El corte de mujer vale $15.000', tipo: 'precio', fecha: '2026-09-12' }],
  });
  return respuesta({
    id: 'r', object: 'response', created_at: 0, model: 'x', status: 'completed',
    output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: aprendido, annotations: [] }] }],
    usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
  });
}) as typeof fetch;

const correr = () =>
  processAprender(admin, { data: { moduleId: 'whatsapp', tenantId: tenant, accountId: cuenta } } as never, { fetchImpl: fetchFalso });

async function autorizar(estado = 'esperando') {
  await admin.query(
    `UPDATE channel_accounts SET config = config || jsonb_build_object('historial', $2::jsonb) WHERE id = $1`,
    [cuenta, JSON.stringify({ estado, autorizadoPor: 'duenia-1406', autorizadoEl: '2026-11-27T10:00:00.000Z' })],
  );
}

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  asegurarAdaptadorDeZernio();
  process.env[LLAVE] = 'zrk_llave_del_negocio_1406';
  process.env.ZERNIO_API_BASE = 'https://zernio.test/api';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-prueba-1406';
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('aprender-1406') RETURNING id")).rows[0].id;
  const c = await withTenant(admin, tenant, async (cl) => {
    const a = await createChannelAccount(cl, {
      tenantId: tenant, kind: 'whatsapp', name: 'WA', credentialRef: LLAVE, provider: 'zernio',
      config: { zernioAccountId: 'acc_1406', zernioProfileId: 'prof_1406', coexistencia: true },
    });
    await setChannelState(cl, { tenantId: tenant, accountId: a.id, state: 'active' });
    return a;
  });
  cuenta = c.id;
});

beforeEach(async () => {
  llamadas.length = 0;
  estadoDeMeta = 'imported';
  // El proveedor de IA sale por el fetch GLOBAL (lo resuelve el SDK): se
  // intercepta ahí para poder mirar su cuerpo.
  globalThis.fetch = fetchFalso;
  await admin.query(`UPDATE channel_accounts SET config = config - 'historial' WHERE id = $1`, [cuenta]);
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

afterAll(async () => {
  for (const tabla of ['chunks', 'sources', 'agent_executions', 'notifications', 'audit_log', 'outbox', 'channel_accounts']) {
    await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [tenant]).catch(() => undefined);
  }
  await admin.end();
});

describe('aprender de los chats', () => {
  it('sin autorización no hay NINGUNA llamada afuera', async () => {
    const r = await correr();
    expect(r).toMatchObject({ terminado: 'sin autorización vigente' });
    expect(llamadas).toHaveLength(0);
  });

  it('con Meta todavía compartiendo, no lee chats ni llama a la IA', async () => {
    await autorizar();
    estadoDeMeta = 'requested';
    await correr().catch(() => undefined); // reprogramar puede lanzar para que la cola reintente
    expect(llamadas.some((l) => l.url.includes('/inbox/'))).toBe(false);
    expect(llamadas.some((l) => !l.url.includes('zernio.test'))).toBe(false);
  });

  it('lo que sale al proveedor de IA no lleva datos de los clientes, y lo aprendido nace por revisar', async () => {
    await autorizar();
    await correr();

    const alProveedor = llamadas.filter((l) => !l.url.includes('zernio.test'));
    expect(alProveedor).toHaveLength(1);
    const cuerpo = alProveedor[0]!.cuerpo;
    for (const dato of Object.values(DEL_CLIENTE)) expect(cuerpo, dato).not.toContain(dato);
    expect(cuerpo).toContain('¿Cuánto vale el corte de mujer?');
    // El grupo no se lee.
    expect(llamadas.filter((l) => l.url.includes('conv-grupo'))).toHaveLength(0);

    const fuentes = await admin.query(`SELECT status FROM sources WHERE tenant_id = $1`, [tenant]);
    expect(fuentes.rows.map((f) => f.status)).toEqual(['por_revisar']);
    const estado = (await admin.query(`SELECT config->'historial'->>'estado' AS e FROM channel_accounts WHERE id = $1`, [cuenta])).rows[0].e;
    expect(estado).toBe('listo');
  });

  it('el texto de los chats no queda en ninguna tabla', async () => {
    await autorizar();
    await correr();
    for (const tabla of ['sources', 'chunks', 'agent_executions', 'audit_log', 'outbox', 'notifications', 'channel_accounts']) {
      const n = await admin
        .query(`SELECT count(*)::int AS n FROM ${tabla} t WHERE t.tenant_id = $1 AND row_to_json(t)::text LIKE '%' || $2 || '%'`, [tenant, MARCADOR])
        .then((r) => r.rows[0].n)
        .catch(() => 0);
      expect(n, tabla).toBe(0);
      for (const dato of Object.values(DEL_CLIENTE)) {
        const m = await admin
          .query(`SELECT count(*)::int AS n FROM ${tabla} t WHERE t.tenant_id = $1 AND row_to_json(t)::text LIKE '%' || $2 || '%'`, [tenant, dato])
          .then((r) => r.rows[0].n)
          .catch(() => 0);
        expect(m, `${tabla}: ${dato}`).toBe(0);
      }
    }
  });
});
