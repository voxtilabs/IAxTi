import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { acceptInvitation, createInvitation, upsertProfile } from '@iaxti/module-identity';
import {
  DifusionError,
  enviarDifusion,
  suprimirDatosDelTitular,
  previsualizarDifusion,
  reintentarDifusion,
  resultadoDifusion,
  sendMessage,
  updateDeliveryStatus,
} from '../contract';
import { receiveInbound } from '../application/conversations';
import { purgeTenantRetention } from '../application/retention';

// La difusión desde la bandeja (#1247): a quién le llega, qué dice la previa
// de quienes quedan fuera, y el reintento que no repite a quien ya recibió.

const actor = randomUUID();

let admin: Pool;
let app: Pool; // rol de aplicación: sin superusuario, RLS activa
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = createPool();
  await runMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='iaxti_difusion_test') THEN
      CREATE ROLE iaxti_difusion_test LOGIN PASSWORD 'iaxti_difusion_test' NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_difusion_test');
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO iaxti_difusion_test');
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON conversations, messages, outbox,
    difusiones, difusion_destinatarios TO iaxti_difusion_test`);
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_difusion_test');
  // Lo que lee la previa para clasificar: el equipo (identity/authorization)
  // y las etiquetas del contacto (crm).
  await admin.query('GRANT SELECT ON contacts, contact_tags, tags, user_profiles, user_roles, roles TO iaxti_difusion_test');
  await admin.query('GRANT INSERT, UPDATE ON contacts TO iaxti_difusion_test');
  const url = new URL(process.env.DATABASE_URL!);
  url.username = 'iaxti_difusion_test';
  url.password = 'iaxti_difusion_test';
  app = createPool(url.toString());
});

afterAll(async () => {
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  tenantA = (await admin.query("INSERT INTO tenants (name) VALUES ('difusion-a') RETURNING id")).rows[0].id;
  tenantB = (await admin.query("INSERT INTO tenants (name) VALUES ('difusion-b') RETURNING id")).rows[0].id;
});

afterEach(async () => {
  for (const tenant of [tenantA, tenantB]) {
    await admin.query('DELETE FROM difusion_destinatarios WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM difusiones WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM processed_events WHERE event_id IN (SELECT id FROM outbox WHERE tenant_id=$1)', [tenant]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [tenant]);
    // audit_log es append-only y no se limpia, y por lo mismo el tenant no se
    // borra: lo referencia la auditoría. Cada prueba usa uno recién nacido,
    // así que su cadena queda corta y aislada.
    await admin.query('DELETE FROM messages WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contact_tags WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM tags WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM user_roles WHERE tenant_id = $1', [tenant]);
    await admin.query('DELETE FROM invitations WHERE tenant_id = $1', [tenant]);
  }
});

/** Una conversación de WhatsApp cuyo último entrante acaba de llegar. */
async function conversacion(phone: string, opts: { haceHoras?: number } = {}) {
  const res = await withTenant(admin, tenantA, (c) =>
    receiveInbound(c, { tenantId: tenantA, phone, channel: 'whatsapp', body: 'hola, gracias por todo' }),
  );
  if (opts.haceHoras !== undefined) {
    await admin.query(
      `UPDATE conversations SET last_inbound_at = now() - ($2 || ' hours')::interval
        WHERE tenant_id = $1 AND id = $3`,
      [tenantA, String(opts.haceHoras), res.conversation.id],
    );
  }
  return res.conversation.id;
}

/** Un miembro del equipo con el teléfono dado: no es un destinatario. */
async function miembroDelEquipo(phone: string) {
  const userId = randomUUID();
  await withTenant(admin, tenantA, async (c) => {
    // ADMIN porque en un tenant recién nacido la primera persona tiene que
    // poder administrar: si no, `assignRole` revierte el INSERT.
    const inv = await createInvitation(c, { tenantId: tenantA, email: `${randomUUID()}@equipo.cl`, roleName: 'ADMIN' });
    await acceptInvitation(c, { token: inv.token, userId });
    await upsertProfile(c, { userId, phone });
  });
  return userId;
}

const previa = (texto = 'Gracias por venir al stand. Acá quedamos: iaxti.cl') =>
  withTenant(admin, tenantA, (c) =>
    previsualizarDifusion(c, {
      tenantId: tenantA, texto, filtro: {}, actor,
      actorKind: 'user', requestId: 'req-previa',
    }),
  );

describe('la previsualización no manda nada y dice quién queda fuera', () => {
  it('cuenta, muestra el teléfono a medias y agrupa los motivos', async () => {
    const enVentana = [await conversacion('+56933310001'), await conversacion('+56933310002')];
    await conversacion('+56933310003', { haceHoras: 30 }); // ventana cerrada
    await conversacion('+56933310004'); // se dio de baja
    await admin.query('UPDATE contacts SET opted_out_at = now() WHERE tenant_id = $1 AND phone = $2', [tenantA, '+56933310004']);
    await miembroDelEquipo('+56933310005');
    await conversacion('+56933310005'); // es del equipo

    const p = await previa();
    expect(p.total).toBe(2);
    expect(p.fuera).toEqual([
      { motivo: 'es del equipo', n: 1 },
      { motivo: 'se dio de baja', n: 1 },
      { motivo: 'ventana cerrada', n: 1 },
    ]);
    // El teléfono a medias: reconocer al grupo sin repartir la lista.
    expect(p.muestra.map((m) => m.telefono).sort()).toEqual(['+56933···01', '+56933···02'].sort());
    // No se mandó nada: los únicos mensajes son los entrantes de prueba.
    const out = await admin.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND direction='out'", [tenantA]);
    expect(out.rows[0].n).toBe(0);
    // La previa congela a los destinatarios para el envío.
    const guardados = await admin.query('SELECT conversation_id FROM difusion_destinatarios WHERE tenant_id=$1 AND difusion_id=$2', [tenantA, p.id]);
    expect(guardados.rows.map((r) => r.conversation_id).sort()).toEqual(enVentana.sort());
    // El silencio NO se afirma acá: depende del reloj de la máquina, y la
    // regla es anclar el instante (los dos tests de abajo lo hacen).
  });

  it('el filtro por estado y por etiqueta estrecha el conjunto', async () => {
    await conversacion('+56933320001');
    const abierta = await conversacion('+56933320002');
    await admin.query('UPDATE conversations SET state = $3 WHERE tenant_id = $1 AND id = $2', [tenantA, abierta, 'open']);

    const porEstado = await withTenant(admin, tenantA, (c) =>
      previsualizarDifusion(c, { tenantId: tenantA, texto: 'x', filtro: { estado: 'open' }, actor, actorKind: 'user' }),
    );
    expect(porEstado.total).toBe(1);

    const tag = (await admin.query("INSERT INTO tags (tenant_id, name) VALUES ($1, 'feria') RETURNING id", [tenantA])).rows[0].id;
    const conEtiqueta = (await admin.query('SELECT contact_id FROM conversations WHERE tenant_id=$1 AND id=$2', [tenantA, abierta])).rows[0].contact_id;
    await admin.query('INSERT INTO contact_tags (tenant_id, contact_id, tag_id) VALUES ($1, $2, $3)', [tenantA, conEtiqueta, tag]);
    const porEtiqueta = await withTenant(admin, tenantA, (c) =>
      previsualizarDifusion(c, { tenantId: tenantA, texto: 'x', filtro: { etiquetaId: tag }, actor, actorKind: 'user' }),
    );
    expect(porEtiqueta.total).toBe(1);
  });
});

describe('el horario de silencio se anuncia, no se impone acá', () => {
  it('de noche dice que el envío se difiere; el worker es quien difiere', async () => {
    // 23:00 del 3 de junio en Chile (UTC-4 estable): pleno silencio.
    const noche = new Date('2026-06-03T03:00:00Z');
    await admin.query(`INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, '+56933330001', 'whatsapp')`, [tenantA]);
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at, last_message_at)
       SELECT $1, id, 'whatsapp', $2, $2 FROM contacts WHERE tenant_id=$1 AND phone='+56933330001'`,
      [tenantA, new Date(noche.getTime() - 60 * 60 * 1000)],
    );
    const p = await withTenant(admin, tenantA, (c) =>
      previsualizarDifusion(c, { tenantId: tenantA, texto: 'x', filtro: {}, actor, actorKind: 'user', ahora: noche }),
    );
    expect(p.enSilencio).toBe(true);
    expect(p.total).toBe(1); // el entrante anclado a la MISMA noche sigue en ventana
  });

  it('a mediodía no hay nada que avisar', async () => {
    const mediodia = new Date('2026-06-03T16:00:00Z');
    await admin.query(`INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, '+56933330002', 'whatsapp')`, [tenantA]);
    await admin.query(
      `INSERT INTO conversations (tenant_id, contact_id, channel, last_inbound_at, last_message_at)
       SELECT $1, id, 'whatsapp', $2, $2 FROM contacts WHERE tenant_id=$1 AND phone='+56933330002'`,
      [tenantA, new Date(mediodia.getTime() - 60 * 60 * 1000)],
    );
    const p = await withTenant(admin, tenantA, (c) =>
      previsualizarDifusion(c, { tenantId: tenantA, texto: 'x', filtro: {}, actor, actorKind: 'user', ahora: mediodia }),
    );
    expect(p.enSilencio).toBe(false);
  });
});

describe('el envío', () => {
  it('crea un mensaje por destinatario, por el camino del negocio', async () => {
    await conversacion('+56933340001');
    await conversacion('+56933340002');
    const p = await previa();

    const envio = await withTenant(admin, tenantA, (c) =>
      enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user', requestId: 'req-envio' }),
    );
    expect(envio.total).toBe(2);
    expect(envio.fuera).toEqual([]);

    const mensajes = await admin.query(
      `SELECT m.*, dt.conversation_id AS dt_conversation
         FROM messages m JOIN difusion_destinatarios dt ON dt.message_id = m.id
        WHERE m.tenant_id = $1 AND dt.difusion_id = $2`,
      [tenantA, p.id],
    );
    expect(mensajes.rows).toHaveLength(2);
    for (const m of mensajes.rows) {
      expect(m.direction).toBe('out');
      expect(m.delivery_status).toBe('queued');
      expect(m.body).toBe('Gracias por venir al stand. Acá quedamos: iaxti.cl');
      expect((m.meta as Record<string, unknown>).difusion).toMatchObject({ id: p.id });
      expect(m.conversation_id).toBe(m.dt_conversation);
    }
    // El pedido durable sale con política business: el consumidor del outbox
    // la traduce a initiatedByBusiness=true y SIN transaccional.
    const eventos = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested'
         AND payload->>'messageId' IN (SELECT message_id::text FROM difusion_destinatarios WHERE difusion_id=$2)`,
      [tenantA, p.id],
    );
    expect(eventos.rows).toHaveLength(2);
    for (const e of eventos.rows) {
      expect(e.payload.policy).toBe('business');
    }
    // Y el envío queda cerrado: no se envía dos veces.
    await expect(
      withTenant(admin, tenantA, (c) => enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user' })),
    ).rejects.toThrow(DifusionError);
  });

  it('quien se dio de baja ENTRE la previa y el envío no recibe', async () => {
    await conversacion('+56933350001');
    await conversacion('+56933350002');
    const p = await previa();
    await admin.query('UPDATE contacts SET opted_out_at = now() WHERE tenant_id=$1 AND phone=$2', [tenantA, '+56933350001']);

    const envio = await withTenant(admin, tenantA, (c) =>
      enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user' }),
    );
    expect(envio.total).toBe(1);
    expect(envio.fuera).toEqual([{ motivo: 'se dio de baja', n: 1 }]);

    const excluido = await admin.query(
      `SELECT dt.excluido FROM difusion_destinatarios dt
         JOIN contacts k ON k.id = dt.contact_id
        WHERE dt.tenant_id=$1 AND dt.difusion_id=$2 AND k.phone='+56933350001'`,
      [tenantA, p.id],
    );
    expect(excluido.rows[0].excluido).toBe('se dio de baja');
    const salientes = await admin.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND direction='out'", [tenantA]);
    expect(salientes.rows[0].n).toBe(1);
  });
});

describe('el resultado y el reintento', () => {
  it('muestra por destinatario el estado y el motivo del fallo', async () => {
    await conversacion('+56933360001');
    await conversacion('+56933360002');
    const p = await previa();
    await withTenant(admin, tenantA, (c) => enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user' }));
    const r = await resultadoDifusionDirecto(p.id);
    expect(r.destinatarios).toHaveLength(2);
    expect(r.estado).toBe('enviada');
    expect(r.total).toBe(2);
    for (const d of r.destinatarios) {
      expect(d.deliveryStatus).toBe('queued');
      expect(d.messageId).toBeTruthy();
    }
  });

  it('reintenta SOLO los fallidos: a quien recibió no se le vuelve a mandar', async () => {
    await conversacion('+56933370001'); // este recibió
    await conversacion('+56933370002'); // este falló
    const p = await previa();
    await withTenant(admin, tenantA, (c) => enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user' }));

    const destinatarios = await admin.query(
      `SELECT dt.conversation_id, dt.message_id, k.phone
         FROM difusion_destinatarios dt JOIN contacts k ON k.id = dt.contact_id
        WHERE dt.tenant_id=$1 AND dt.difusion_id=$2`,
      [tenantA, p.id],
    );
    const porTelefono = new Map(destinatarios.rows.map((r) => [r.phone, r]));
    const recibido = porTelefono.get('+56933370001');
    const fallido = porTelefono.get('+56933370002');
    await withTenant(admin, tenantA, (c) =>
      updateDeliveryStatus(c, { tenantId: tenantA, messageId: recibido.message_id, status: 'sent', providerMessageId: 'wamid.ok' }),
    );
    await withTenant(admin, tenantA, (c) =>
      updateDeliveryStatus(c, { tenantId: tenantA, messageId: fallido.message_id, status: 'failed', error: 'El canal rechazó el mensaje.' }),
    );

    const reintento = await withTenant(admin, tenantA, (c) =>
      reintentarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user', requestId: 'req-reintento' }),
    );
    expect(reintento.reintentados).toBe(1);

    // Quien recibió sigue con su ÚNICO mensaje, que ya no es retryable.
    const delQueRecibio = await admin.query(
      "SELECT count(*)::int AS n FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='out'",
      [tenantA, recibido.conversation_id],
    );
    expect(delQueRecibio.rows[0].n).toBe(1);
    // El fallido tiene DOS: el que falló (queda de historia) y el nuevo, queued.
    const delQueFallo = await admin.query(
      "SELECT delivery_status FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND direction='out' ORDER BY created_at",
      [tenantA, fallido.conversation_id],
    );
    expect(delQueFallo.rows.map((r) => r.delivery_status)).toEqual(['failed', 'queued']);
    const r = await resultadoDifusionDirecto(p.id);
    const destinatarioFallido = r.destinatarios.find((d) => d.conversationId === fallido.conversation_id);
    expect(destinatarioFallido?.intentos).toBe(2);
    // El nuevo reintento también sale como envío del negocio.
    const evento = await admin.query(
      `SELECT payload FROM outbox WHERE tenant_id=$1 AND name='message.delivery_requested' AND payload->>'messageId'=$2`,
      [tenantA, destinatarioFallido?.messageId],
    );
    expect(evento.rows[0].payload.policy).toBe('business');
  });
});

describe('aislamiento entre negocios (RLS)', () => {
  it('un tenant no ve las difusiones ni los destinatarios de otro', async () => {
    await conversacion('+56933380001');
    const p = await previa();
    await withTenant(admin, tenantA, (c) => enviarDifusion(c, { tenantId: tenantA, difusionId: p.id, actor, actorKind: 'user' }));

    // Como rol de aplicación, dentro del tenant B.
    const difusiones = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM difusiones'));
    const destinatarios = await withTenant(app, tenantB, (c) => c.query('SELECT * FROM difusion_destinatarios'));
    expect(difusiones.rowCount).toBe(0);
    expect(destinatarios.rowCount).toBe(0);
    // Y tampoco puede leer el envío del otro tenant por el caso de uso.
    await expect(
      withTenant(app, tenantB, (c) => resultadoDifusion(c, { tenantId: tenantB, difusionId: p.id })),
    ).rejects.toThrow(DifusionError);
  });
});

/** El resultado con el tenant A desde el rol de administración (sin RLS). */
async function resultadoDifusionDirecto(difusionId: string) {
  return withTenant(admin, tenantA, (c) => resultadoDifusion(c, { tenantId: tenantA, difusionId }));
}

describe('sendMessage sigue siendo el camino (regresión leve)', () => {
  it('un mensaje de difusión es un mensaje como cualquier otro', async () => {
    const conversationId = await conversacion('+56933390001');
    const m = await withTenant(admin, tenantA, (c) =>
      sendMessage(c, { tenantId: tenantA, conversationId, authorKind: 'user', authorId: actor, body: 'hola', delivery: 'business' }),
    );
    expect(m.deliveryStatus).toBe('queued');
  });
});

/**
 * Una difusión no puede trabar el borrado que pide la ley (#1247).
 *
 * La supresión del titular (#235) borra sus mensajes, y el destinatario de una
 * difusión apunta a uno de ellos. Con la llave foránea a secas, el DELETE de
 * la supresión reventaba: el titular pedía que lo olvidaran y el sistema no
 * podía. Lo mismo la purga por retención (SPEC §39), que borra mensajes y
 * conversaciones. Se encontró revisando el PR, no por una prueba: por eso
 * esta existe.
 */
describe('una difusión no traba el borrado (#235, SPEC §39)', () => {
  it('la supresión del titular borra sus mensajes aunque una difusión los apunte', async () => {
    const conv = await conversacion('+56933390001');
    const { id } = await previa();
    await withTenant(admin, tenantA, (c) =>
      enviarDifusion(c, { tenantId: tenantA, difusionId: id, actor, actorKind: 'user' }),
    );
    const contacto = (
      await admin.query('SELECT contact_id FROM conversations WHERE id = $1', [conv])
    ).rows[0].contact_id as string;

    await withTenant(admin, tenantA, (c) =>
      suprimirDatosDelTitular(c, {
        tenantId: tenantA, contactId: contacto, conversationIds: [conv], actor, requestId: 'req-supresion',
      }),
    );

    const quedan = await admin.query(
      'SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2',
      [tenantA, conv],
    );
    expect(quedan.rows[0].n).toBe(0);
    // El destinatario sigue —hubo un envío— pero ya no apunta a un mensaje.
    const dest = await admin.query(
      'SELECT message_id FROM difusion_destinatarios WHERE difusion_id = $1 AND conversation_id = $2',
      [id, conv],
    );
    expect(dest.rows[0].message_id).toBeNull();
  });

  it('la purga por retención no se traba con una difusión que apunta a la conversación', async () => {
    // Un negocio propio en el plan `base` (12 meses de retención) y una
    // conversación resuelta de hace 14: la purga REAL tiene que poder
    // borrarla aunque una difusión la tenga como destinataria — y sin
    // `difusion_destinatarios` en su lista, la llave foránea la trababa.
    const t = (await admin.query(
      "INSERT INTO tenants (name, plan, state) VALUES ('difusion-purga', 'base', 'active') RETURNING id",
    )).rows[0].id as string;
    const res = await withTenant(admin, t, (c) =>
      receiveInbound(c, { tenantId: t, phone: '+56933390002', channel: 'whatsapp', body: 'hola' }),
    );
    const conv = res.conversation.id;
    const d = await withTenant(admin, t, (c) =>
      previsualizarDifusion(c, { tenantId: t, texto: 'gracias', filtro: {}, actor, actorKind: 'user' }),
    );
    await withTenant(admin, t, (c) =>
      enviarDifusion(c, { tenantId: t, difusionId: d.id, actor, actorKind: 'user' }),
    );
    // Ahora la conversación envejece: resuelta, último mensaje hace 14 meses.
    await admin.query(
      `UPDATE conversations SET state = 'resolved', last_message_at = now() - make_interval(months => 14)
        WHERE id = $1`,
      [conv],
    );

    const purga = await purgeTenantRetention(admin, t, { detachSessions: async () => {} });
    expect(purga?.purged).toBe(1);
    const sigue = await admin.query('SELECT count(*)::int AS n FROM conversations WHERE id = $1', [conv]);
    expect(sigue.rows[0].n).toBe(0);

    for (const tabla of ['difusion_destinatarios', 'difusiones', 'messages', 'conversations', 'contacts', 'outbox']) {
      await admin.query(`DELETE FROM ${tabla} WHERE tenant_id = $1`, [t]);
    }
  });
});
