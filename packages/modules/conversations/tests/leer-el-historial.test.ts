import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { listMessages, receiveInbound, sendMessage } from '../application/conversations';

/**
 * Leer el historial hacia atrás (#581).
 *
 * `listMessages` devolvía los últimos 50 y ahí se terminaba: no había forma de
 * pedir los anteriores. Una conversación de tres meses mostraba su último pedazo
 * y el resto no estaba al alcance de nadie — ni de quien toma una conversación
 * que atendía otra persona y necesita ver qué se le prometió al cliente, ni del
 * copiloto, que arma su contexto con lo que hay.
 *
 * El cursor es `seq` y no la fecha, y esa decisión es lo que estas pruebas
 * cuidan: `seq` es estrictamente creciente por conversación, así que paginar por
 * él no puede saltarse ni repetir un mensaje aunque dos lleguen en el mismo
 * milisegundo. Con `created_at` sí puede, y en WhatsApp llegan ráfagas — la
 * prueba de abajo mete 120 mensajes de un tirón justo por eso.
 */

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let conversacion: string;
const TOTAL = 120;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  tenant = (await admin.query("INSERT INTO tenants (name) VALUES ('historial') RETURNING id"))
    .rows[0].id;
  const entrada = await withTenant(admin, tenant, (c) =>
    receiveInbound(c, {
      tenantId: tenant,
      phone: '+56911112222',
      channel: 'simulador',
      body: 'mensaje 0',
    }),
  );
  conversacion = entrada.conversation.id;
  // 119 más, sin esperar entre uno y otro: varios caen en el mismo milisegundo,
  // que es exactamente donde un cursor por fecha se rompe.
  await withTenant(admin, tenant, async (c) => {
    for (let i = 1; i < TOTAL; i++) {
      await sendMessage(c, {
        tenantId: tenant,
        conversationId: conversacion,
        authorKind: 'agent',
        body: `mensaje ${i}`,
      });
    }
  });
});

afterAll(async () => {
  await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM usage_meters WHERE tenant_id = $1', [tenant]);
  await admin.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await admin.end();
});

const pagina = (limite: number, antesDe?: number) =>
  withTenant(admin, tenant, (c) => listMessages(c, tenant, conversacion, limite, antesDe));

describe('el historial se puede leer entero (#581)', () => {
  it('sin cursor trae la ÚLTIMA página, más nuevos primero', async () => {
    const p = await pagina(50);
    expect(p).toHaveLength(50);
    expect(p[0].body).toBe(`mensaje ${TOTAL - 1}`);
    expect(p[49].body).toBe(`mensaje ${TOTAL - 50}`);
  });

  it('paginando hacia atrás se llega al primer mensaje, sin saltarse ni repetir ninguno', async () => {
    const vistos: string[] = [];
    let cursor: number | undefined;
    // Tope de vueltas: si el cursor no avanzara, esto sería un bucle infinito y
    // la prueba se colgaría en vez de fallar.
    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const p = await pagina(50, cursor);
      if (p.length === 0) break;
      vistos.push(...p.map((m) => m.body!));
      cursor = p[p.length - 1].seq;
      if (p.length < 50) break;
    }
    // Los 120, cada uno UNA vez. Eso es lo que un cursor por fecha no garantiza.
    expect(vistos).toHaveLength(TOTAL);
    expect(new Set(vistos).size).toBe(TOTAL);
    expect(vistos[0]).toBe(`mensaje ${TOTAL - 1}`);
    expect(vistos[TOTAL - 1]).toBe('mensaje 0');
  });

  it('la última página viene CORTA, que es como se sabe que se llegó al principio', async () => {
    const p1 = await pagina(50);
    const p2 = await pagina(50, p1[49].seq);
    const p3 = await pagina(50, p2[49].seq);
    expect(p3.length).toBeLessThan(50);
    expect(p3[p3.length - 1].body).toBe('mensaje 0');
  });

  it('el cursor es EXCLUSIVO: el mensaje del cursor no vuelve a venir', async () => {
    const p1 = await pagina(10);
    const p2 = await pagina(10, p1[9].seq);
    expect(p2.map((m) => m.seq)).not.toContain(p1[9].seq);
    expect(p2[0].seq).toBeLessThan(p1[9].seq);
  });

  it('un cursor más viejo que todo devuelve vacío en vez de reventar', async () => {
    expect(await pagina(10, 1)).toHaveLength(0);
  });

  it('el seq viaja: sin él, quien lee no puede pedir la página siguiente', async () => {
    const p = await pagina(3);
    for (const m of p) expect(Number.isSafeInteger(m.seq)).toBe(true);
    // Y estrictamente decreciente dentro de la página, que es el orden que la
    // pantalla da vuelta para dibujar.
    expect(p[0].seq).toBeGreaterThan(p[1].seq);
    expect(p[1].seq).toBeGreaterThan(p[2].seq);
  });

  it('el tope de 100 se respeta aunque se pida más', async () => {
    expect(await pagina(500)).toHaveLength(100);
  });
});
