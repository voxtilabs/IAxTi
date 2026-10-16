import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { suprimirTitular } from '@iaxti/module-crm';
import { verifyChain } from '@iaxti/module-audit';
import { supresionEnModulos } from '../src/supresion-titular';

// Los contratos reales, con Postgres real y un rol sin bypass, por la MISMA
// composición que consume la ruta. El rol de fixture es exclusivo del archivo.
let admin: Pool;
const rol = `titular_${randomUUID().replaceAll('-', '')}`;
const actor = randomUUID();
const frase = 'Texto personal que se debe suprimir';
const acciones = [
  'agents.titular.suprimido',
  'conversations.titular.suprimido',
  'integrations.titular.suprimido',
  'payments.titular.suprimido',
  'analytics.titular.suprimido',
  'titular.suprimido',
];

beforeAll(async () => {
  admin = createPool(process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti');
  await runMigrations(admin);
  await admin.query(`CREATE ROLE ${rol} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${rol}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rol}`);
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rol}`);
  await admin.query(`REVOKE UPDATE, DELETE ON audit_log FROM ${rol}`);
});

afterAll(async () => {
  // Los datos son fixtures aislados por UUID. Se conserva el audit append-only.
  await admin.query(`DROP OWNED BY ${rol}`);
  await admin.query(`DROP ROLE ${rol}`);
  await admin.end();
});

async function conRls<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) {
  return withTenant(admin, tenantId, async (c) => {
    await c.query(`SET LOCAL ROLE ${rol}`);
    const estado = await c.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(estado.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    return fn(c);
  });
}

async function fixture() {
  const tenantId = (await admin.query("INSERT INTO tenants (name) VALUES ('supresion-903') RETURNING id")).rows[0].id as string;
  return withTenant(admin, tenantId, async (c) => {
    const contactId = (await c.query('INSERT INTO contacts (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenantId, frase])).rows[0].id as string;
    const conversationId = (await c.query('INSERT INTO conversations (tenant_id, contact_id, summary) VALUES ($1, $2, $3) RETURNING id', [tenantId, contactId, frase])).rows[0].id as string;
    const messageId = (await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, type, body, author_kind) VALUES ($1, $2, 'in', 'texto', $3, 'contact') RETURNING id", [tenantId, conversationId, frase])).rows[0].id as string;
    await c.query('INSERT INTO internal_notes (tenant_id, conversation_id, author_id, body) VALUES ($1, $2, $3, $4)', [tenantId, conversationId, actor, frase]);
    const executionId = (await c.query("INSERT INTO agent_executions (tenant_id, task, provider, model, input, output, explanation, tokens_in, cost_usd) VALUES ($1, 'sugerir', 'fixture', 'fixture', to_jsonb($2::text), to_jsonb($2::text), $2, 123, 0.001) RETURNING id", [tenantId, frase])).rows[0].id as string;
    await c.query('INSERT INTO suggestions (tenant_id, conversation_id, message_id, execution_id, text) VALUES ($1, $2, $3, $4, $5)', [tenantId, conversationId, messageId, executionId, frase]);
    const endpointId = (await c.query("INSERT INTO webhook_endpoints (tenant_id, url, secret) VALUES ($1, 'https://example.invalid', 'fixture') RETURNING id", [tenantId])).rows[0].id as string;
    const deliveryId = (await c.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_name, payload, response_body) VALUES ($1, $2, 1, 'contact.created', jsonb_build_object('contactId', $3::text, 'texto', $4::text), $4) RETURNING id", [tenantId, endpointId, contactId, frase])).rows[0].id as string;
    const providerId = (await c.query("INSERT INTO payment_providers (tenant_id, kind, name, credential_ref) VALUES ($1, 'simulado', 'Prueba', 'FIXTURE') RETURNING id", [tenantId])).rows[0].id as string;
    const links = await c.query("INSERT INTO payment_links (tenant_id, provider_id, contact_id, conversation_id, amount_clp, concept, status) VALUES ($1, $2, $3, $4, 1500, $5, 'created'), ($1, $2, $3, $4, 2000, $5, 'paid') RETURNING id, status", [tenantId, providerId, contactId, conversationId, frase]);
    await c.query("INSERT INTO response_samples (tenant_id, conversation_id, day, seconds) VALUES ($1, $2, '2026-10-15', 15)", [tenantId, conversationId]);
    return { tenantId, contactId, conversationId, executionId, deliveryId, paidId: links.rows.find((r) => r.status === 'paid').id as string };
  });
}

async function estado(f: Awaited<ReturnType<typeof fixture>>) {
  return withTenant(admin, f.tenantId, async (c) => {
    const r = await c.query<{ archivo: Date | null } & Record<string, unknown>>(`SELECT
      (SELECT name FROM contacts WHERE id = $1) AS nombre,
      (SELECT summary FROM conversations WHERE id = $2) AS resumen,
      (SELECT archived_at FROM conversations WHERE id = $2) AS archivo,
      (SELECT count(*)::int FROM messages WHERE conversation_id = $2) AS mensajes,
      (SELECT count(*)::int FROM internal_notes WHERE conversation_id = $2) AS notas,
      (SELECT count(*)::int FROM suggestions WHERE conversation_id = $2) AS sugerencias,
      (SELECT input FROM agent_executions WHERE id = $3) AS entrada,
      (SELECT output FROM agent_executions WHERE id = $3) AS salida,
      (SELECT explanation FROM agent_executions WHERE id = $3) AS explicacion,
      (SELECT payload FROM webhook_deliveries WHERE id = $4) AS payload,
      (SELECT response_body FROM webhook_deliveries WHERE id = $4) AS respuesta,
      (SELECT count(*)::int FROM response_samples WHERE conversation_id = $2) AS muestras`, [f.contactId, f.conversationId, f.executionId, f.deliveryId]);
    const pagos = (await c.query<{ id: string; amount_clp: string; concept: string; status: string; created_at: Date }>('SELECT id, amount_clp, concept, status, created_at FROM payment_links WHERE tenant_id = $1 ORDER BY amount_clp', [f.tenantId])).rows;
    const audit = (await c.query<{ action: string; actor: string; request_id: string; metadata: Record<string, unknown> }>('SELECT action, actor, request_id, metadata FROM audit_log WHERE tenant_id = $1 ORDER BY id', [f.tenantId])).rows;
    return { ...r.rows[0], pagos, audit };
  });
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
  return { tenantId: f.tenantId, contactId: f.contactId, actor, motivo: 'solicitud', requestId: randomUUID(), almacen: null, modulos: supresionEnModulos };
}

describe('supresión contractual, atómica y aislada (#903)', () => {
  it('un fallo de auditoría en la tercera parte revierte las dos primeras y sus rastros', async () => {
    const f = await fixture();
    const antes = await estado(f);
    let terceraAlcanzada = false;
    await expect(conRls(f.tenantId, async (c) => {
      const falloEnTercera = new Proxy(c, {
        get(target, prop) {
          if (prop === 'query') return async (sql: string, params?: unknown[]) => {
            if (sql.includes('INSERT INTO audit_log') && params?.[3] === 'integrations.titular.suprimido') {
              terceraAlcanzada = true;
              // Las dos primeras aplicaron y auditaron, pero no confirmaron.
              expect((await target.query('SELECT action FROM audit_log WHERE tenant_id = $1 ORDER BY id', [f.tenantId])).rows.map((r) => r.action)).toEqual(acciones.slice(0, 2));
              expect((await target.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [f.conversationId])).rows[0].n).toBe(0);
              expect((await target.query('SELECT input FROM agent_executions WHERE id = $1', [f.executionId])).rows[0].input).toEqual({});
              // Falla Postgres realmente, sin triggers compartidos ni mutaciones de esquema.
              return target.query('SELECT 1 / 0');
            }
            return target.query(sql, params);
          };
          return Reflect.get(target, prop);
        },
      });
      return suprimirTitular(falloEnTercera, input(f));
    })).rejects.toThrow(/division by zero/);
    expect(terceraAlcanzada).toBe(true);
    expect(await estado(f)).toEqual(antes);
  });

  it('suprime todos los dueños, audita cada parte y conserva las cifras de cobros pagados', async () => {
    const f = await fixture();
    const otro = await fixture();
    // Mismo id citado en el payload de otro tenant: el filtro de negocio importa.
    await admin.query('UPDATE webhook_deliveries SET payload = jsonb_build_object(\'contactId\', $1::text) WHERE id = $2', [f.contactId, otro.deliveryId]);
    const otroAntes = await estado(otro);
    const antes = await estado(f);
    const solicitud = input(f);
    const resultado = await conRls(f.tenantId, (c) => suprimirTitular(c, solicitud));
    expect(resultado.mensajesBorrados).toBe(1);
    expect(resultado.ejecucionesVaciadas).toBe(1);
    const despues = await estado(f);
    expect(despues).toMatchObject({ nombre: null, resumen: null, mensajes: 0, notas: 0, sugerencias: 0, entrada: {}, salida: null, explicacion: null, payload: {}, respuesta: null, muestras: 0 });
    expect(despues.archivo).not.toBeNull();
    expect(despues.pagos).toEqual(antes.pagos.map((r) => ({ ...r, concept: '' })));
    expect(despues.audit.map((r) => r.action)).toEqual(acciones);
    expect(despues.audit.every((r) => r.actor === actor && r.request_id === solicitud.requestId)).toBe(true);
    expect(despues.audit.map((r) => r.metadata)).toEqual([
      { ejecucionesVaciadas: 1, sugerenciasBorradas: 1 },
      { mensajesBorrados: 1, notasBorradas: 1, conversacionesArchivadas: 1 },
      { entregasVaciadas: 1 }, { conceptosVaciados: 2 }, { muestrasBorradas: 1 },
      expect.objectContaining({ mensajesBorrados: 1, ejecucionesVaciadas: 1 }),
    ]);
    expect(await conRls(f.tenantId, (c) => verifyChain(c, f.tenantId))).toMatchObject({ valid: true, entries: 6 });
    expect(await estado(otro)).toEqual(otroAntes);
    // Reintentar es seguro incluso cuando el cobro pagado ya está vacío.
    await conRls(f.tenantId, (c) => suprimirTitular(c, solicitud));
    expect((await estado(f)).pagos).toEqual(despues.pagos);
  });

  it('RLS impide suprimir el contacto ajeno y cada contrato rechaza contexto de otro tenant', async () => {
    const a = await fixture();
    const b = await fixture();
    const antes = await estado(b);
    await expect(conRls(a.tenantId, (c) => suprimirTitular(c, input(b)))).rejects.toThrow(/No encontramos/);
    for (const nombre of ['agents', 'conversations', 'integrations', 'payments', 'analytics'] as const) {
      await expect(conRls(a.tenantId, async (c) => {
        await supresionEnModulos[nombre](c, { tenantId: b.tenantId, contactId: b.contactId, conversationIds: [b.conversationId], actor });
      })).rejects.toThrow(/row-level security/);
    }
    expect(await estado(b)).toEqual(antes);
  });

  it('vaciar el concepto no permite cambiar dinero, estado u otra columna de un cobro pagado', async () => {
    const f = await fixture();
    for (const cambios of ["concept = '', amount_clp = 1", "concept = '', status = 'created'", "concept = '', url = 'https://example.invalid/cambio'", "concept = 'otro texto'"]) {
      await expect(conRls(f.tenantId, (c) => c.query(`UPDATE payment_links SET ${cambios} WHERE id = $1`, [f.paidId]))).rejects.toThrow(/inmutable/);
    }
    await expect(conRls(f.tenantId, (c) => c.query('DELETE FROM payment_links WHERE id = $1', [f.paidId]))).rejects.toThrow(/inmutable/);
  });
});
