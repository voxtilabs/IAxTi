import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { parseSuggestion } from '../domain/parser';
import {
  ACCIONES_EN_LA_CONVERSACION,
  accionQueSePuedeProponer,
} from '../application/acciones-en-la-conversacion';
import { aplicarAccionDeLaSugerencia } from '../application/acciones-que-se-proponen';
import { CATALOGO } from '../application/catalogo';

/**
 * El asistente propone la acción; el dueño aplica (#1000).
 *
 * El hueco que esto cierra: el asistente ya contesta solo —`autoRespondForInbound`
 * manda el mensaje firmado— pero no puede HACER. Las siete herramientas que
 * escriben están cerradas por ADR-0017 («sale hacia el cliente o pisa trabajo de
 * una persona»), así que cuando el cliente dice «agéndame el jueves a las 4», el
 * asistente VE los huecos y no puede agendar: la conversación llega al punto de
 * la acción y se detiene.
 *
 * Esto no abre esas puertas. Las convierte en una propuesta que una persona
 * aplica en un toque, con SUS permisos, por la misma función que usa el Agente
 * General. El ADR decía que esas acciones las decide una persona; acá las
 * decide.
 */
let pool: Pool;
let tenant: string;
let conversacion: string;
let contactoId: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (
    await pool.query("INSERT INTO tenants (name) VALUES ('jose-propone') RETURNING id")
  ).rows[0].id;
  // Una conversación REAL con su contacto: desde #1049 aplicar hace JOIN con
  // conversations para inyectar lo que el sistema sabe (contactId, id).
  const contacto = await pool.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1,'Prueba','+56999001999','whatsapp') RETURNING id`,
    [tenant],
  );
  contactoId = contacto.rows[0].id;
  const conv = await pool.query(
    `INSERT INTO conversations (tenant_id, contact_id, channel, state) VALUES ($1,$2,'simulador','open') RETURNING id`,
    [tenant, contactoId],
  );
  conversacion = conv.rows[0].id;
});
afterAll(async () => {
  await pool.query('DELETE FROM suggestions WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM conversations WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM contacts WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
  await pool.end();
});

const guardar = async (accion: unknown) =>
  (
    await pool.query(
      `INSERT INTO suggestions (tenant_id, conversation_id, text, accion)
            VALUES ($1, $2, 'Te dejo la hora lista para confirmar.', $3) RETURNING id`,
      [tenant, conversacion, accion === null ? null : JSON.stringify(accion)],
    )
  ).rows[0].id as string;

describe('lo que el asistente puede proponer', () => {
  it('cada nombre de la lista existe en el catálogo y sigue pidiendo visto bueno', () => {
    // La lista es corta a mano y el catálogo se genera del código: sin esta
    // prueba, renombrar una ruta dejaría una entrada apuntando a nada y la
    // acción se caería recién cuando un cliente la pidiera.
    for (const nombre of Object.keys(ACCIONES_EN_LA_CONVERSACION)) {
      const h = CATALOGO.find((x) => x.nombre === nombre);
      expect(h, `${nombre} no está en el catálogo`).toBeDefined();
      expect(h?.trato, `${nombre} dejó de pedir confirmación`).toBe('confirmar');
    }
  });

  it('cada entrada trae su motivo escrito, no una cadena vacía', () => {
    for (const [nombre, motivo] of Object.entries(ACCIONES_EN_LA_CONVERSACION)) {
      expect(motivo.trim().length, nombre).toBeGreaterThan(40);
    }
  });

  it('`conversations.reply` NO está: eso ya es la sugerencia', () => {
    // Dos mecanismos para lo mismo y el segundo siempre queda a medias.
    expect(ACCIONES_EN_LA_CONVERSACION['conversations.reply']).toBeUndefined();
  });

  it('deja pasar lo de la lista y descarta lo demás', () => {
    expect(accionQueSePuedeProponer({ herramienta: 'agenda.agendar', argumentos: {} })).toEqual({
      herramienta: 'agenda.agendar',
      argumentos: {},
    });
    // Existe en el catálogo, pide confirmación, y NO es de esta conversación:
    // un asistente hablando con un cliente no toca la plataforma.
    expect(accionQueSePuedeProponer({ herramienta: 'platform.apagarModulo', argumentos: {} })).toBeNull();
    expect(accionQueSePuedeProponer({ herramienta: 'no.existe', argumentos: {} })).toBeNull();
    expect(accionQueSePuedeProponer(null)).toBeNull();
  });
});

describe('el parser de la acción', () => {
  const con = (json: string) => parseSuggestion(json).accion;

  it('la lee cuando viene bien', () => {
    expect(
      con('{"sugerencia":"Te la dejo lista","accion":{"herramienta":"agenda.agendar","argumentos":{"inicio":"2026-11-03T16:00:00Z"}}}'),
    ).toEqual({ herramienta: 'agenda.agendar', argumentos: { inicio: '2026-11-03T16:00:00Z' } });
  });

  it('sin argumentos vale: hay acciones que no los necesitan', () => {
    expect(con('{"sugerencia":"ok","accion":{"herramienta":"agenda.estado"}}')).toEqual({
      herramienta: 'agenda.estado',
      argumentos: {},
    });
  });

  it('una acción a medias se pierde y la RESPUESTA se conserva', () => {
    // Lo contrario sería cambiar un problema chico —no propuso nada— por uno
    // grande: quien atiende se queda sin el texto para contestarle al cliente.
    for (const malo of [
      '{"sugerencia":"Hola","accion":{"argumentos":{}}}',
      '{"sugerencia":"Hola","accion":{"herramienta":"","argumentos":{}}}',
      '{"sugerencia":"Hola","accion":{"herramienta":"agenda.agendar","argumentos":"el jueves"}}',
      '{"sugerencia":"Hola","accion":[1,2]}',
      '{"sugerencia":"Hola","accion":"agendale"}',
    ]) {
      const p = parseSuggestion(malo);
      expect(p.accion, malo).toBeNull();
      expect(p.sugerencia, malo).toBe('Hola');
    }
  });

  it('sin acción es el caso normal, no un error', () => {
    expect(con('{"sugerencia":"Abrimos de 9 a 18."}')).toBeNull();
  });
});

describe('aplicar', () => {
  const PERMISOS = new Set(['calendar.book']);
  const MODULOS = new Set(['calendar', 'conversations']);

  /**
   * Reagendar desde el chat, que es la promesa de SPEC §16 y el cierre de #836.
   *
   * «Reagendar y cancelar desde el chat ("¿puedo cambiarla?") CON
   * confirmación»: el asistente propone `agenda.mover` con la cita y la hora
   * nueva, quien atiende confirma, y la acción sale por la MISMA ruta que el
   * botón de la agenda — `POST /v1/agenda/{id}/mover`, con su hueco comprobado
   * y su evento `appointment.rescheduled` (#958).
   *
   * Lo que esta prueba agrega sobre la de agendar: la ruta lleva `{id}` en el
   * camino, así que acá se comprueba que `repartirArgumentos` lo SUSTITUYA en
   * vez de mandarlo en el cuerpo. Si eso se rompiera, la llamada iría a una
   * ruta literal con llaves y el reagendado nunca llegaría al endpoint.
   */
  it('lo que el sistema sabe lo pone el sistema: contacto y conversación, pisando al modelo (#1049)', async () => {
    // El caso medido en vivo: el modelo armó agenda.agendar con «nombre» y
    // «telefono» inventados razonables y SIN contactId — la ruta lo rechazó
    // («La cita necesita contacto, inicio y fin») y Confirmar fallaba
    // siempre. Peor aún: un contactId adivinado por el modelo agendaría a
    // OTRA persona, así que el real lo pisa.
    const id = await guardar({
      herramienta: 'agenda.agendar',
      argumentos: {
        inicio: '2026-10-29T16:00:00-03:00',
        fin: '2026-10-29T17:00:00-03:00',
        title: 'Corte de pelo',
        contactId: 'adivinado-por-el-modelo',
      },
    });
    const llamadas: Array<{ ruta: string; cuerpo: Record<string, unknown> }> = [];
    await withTenant(pool, tenant, (c) =>
      aplicarAccionDeLaSugerencia(
        c,
        {
          tenantId: tenant,
          suggestionId: id,
          permisos: new Set(['calendar.book']),
          modulosActivos: new Set(['calendar']),
        },
        {
          llamarApi: async ({ ruta, cuerpo }) => {
            llamadas.push({ ruta, cuerpo: cuerpo as Record<string, unknown> });
            return { ok: true, estado: 201, datos: { creada: true } };
          },
        },
      ),
    );
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].ruta).toBe('/v1/agenda');
    expect(llamadas[0].cuerpo.contactId).toBe(contactoId);
    expect(llamadas[0].cuerpo.conversationId).toBe(conversacion);
    // Y lo que el modelo sí sabe, viaja intacto.
    expect(llamadas[0].cuerpo.inicio).toBe('2026-10-29T16:00:00-03:00');
    expect(llamadas[0].cuerpo.title).toBe('Corte de pelo');
  });

  it('cambiar el estado de la conversación va a ESTA conversación, diga lo que diga el modelo', async () => {
    const id = await guardar({
      herramienta: 'conversations.state',
      argumentos: { state: 'resolved', id: 'otra-conversacion-inventada' },
    });
    const llamadas: Array<{ ruta: string }> = [];
    await withTenant(pool, tenant, (c) =>
      aplicarAccionDeLaSugerencia(
        c,
        {
          tenantId: tenant,
          suggestionId: id,
          permisos: new Set(['conversations.resolve']),
          modulosActivos: new Set(['conversations']),
        },
        {
          llamarApi: async ({ ruta }) => {
            llamadas.push({ ruta });
            return { ok: true, estado: 200, datos: {} };
          },
        },
      ),
    );
    expect(llamadas[0].ruta).toBe(`/v1/conversations/${conversacion}/state`);
  });

  it('reagendar desde el chat: el id viaja EN la ruta, no en el cuerpo', async () => {
    const id = await guardar({
      herramienta: 'agenda.mover',
      argumentos: { id: 'cita-77', inicio: '2026-11-05T15:00:00Z' },
    });
    const llamadas: Array<{ metodo: string; ruta: string; cuerpo: unknown }> = [];
    const r = await withTenant(pool, tenant, (c) =>
      aplicarAccionDeLaSugerencia(
        c,
        {
          tenantId: tenant,
          suggestionId: id,
          permisos: new Set(['calendar.book']),
          modulosActivos: new Set(['calendar']),
        },
        {
          llamarApi: async ({ metodo, ruta, cuerpo }) => {
            llamadas.push({ metodo, ruta, cuerpo });
            return { ok: true, estado: 200, datos: { movida: true } };
          },
        },
      ),
    );
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].metodo).toBe('POST');
    expect(llamadas[0].ruta).toBe('/v1/agenda/cita-77/mover');
    // Y el id NO se repite en el cuerpo: ya viajó en la ruta.
    expect(llamadas[0].cuerpo).toEqual({ inicio: '2026-11-05T15:00:00Z' });
    expect(r.suggestion.status).toBe('sent');
  });

  it('ejecuta por la ruta, con los permisos de la persona, y recién ahí marca enviada', async () => {
    const id = await guardar({ herramienta: 'agenda.agendar', argumentos: { contactId: 'c1' } });
    const llamadas: Array<{ metodo: string; ruta: string }> = [];
    const r = await withTenant(pool, tenant, (c) =>
      aplicarAccionDeLaSugerencia(
        c,
        { tenantId: tenant, suggestionId: id, permisos: PERMISOS, modulosActivos: MODULOS },
        {
          llamarApi: async ({ metodo, ruta }) => {
            llamadas.push({ metodo, ruta });
            return { ok: true, estado: 201, datos: { id: 'cita-1' } };
          },
        },
      ),
    );
    expect(llamadas).toEqual([{ metodo: 'POST', ruta: '/v1/agenda' }]);
    expect(r.suggestion.status).toBe('sent');
    expect(r.datos).toEqual({ id: 'cita-1' });
  });

  it('sin el permiso de la persona no se ejecuta, y la sugerencia sigue viva', async () => {
    const id = await guardar({ herramienta: 'agenda.agendar', argumentos: {} });
    let llamo = false;
    await expect(
      withTenant(pool, tenant, (c) =>
        aplicarAccionDeLaSugerencia(
          c,
          { tenantId: tenant, suggestionId: id, permisos: new Set<string>(), modulosActivos: MODULOS },
          { llamarApi: async () => ((llamo = true), { ok: true, estado: 200, datos: {} }) },
        ),
      ),
    ).rejects.toThrow(/permiso/i);
    expect(llamo, 'no tenía que llamar a la ruta').toBe(false);
    const q = await pool.query('SELECT status FROM suggestions WHERE id = $1', [id]);
    expect(q.rows[0].status).toBe('pending');
  });

  it('si la ruta falla, la sugerencia queda PENDIENTE para volver a intentar', async () => {
    const id = await guardar({ herramienta: 'agenda.agendar', argumentos: {} });
    await expect(
      withTenant(pool, tenant, (c) =>
        aplicarAccionDeLaSugerencia(
          c,
          { tenantId: tenant, suggestionId: id, permisos: PERMISOS, modulosActivos: MODULOS },
          { llamarApi: async () => ({ ok: false, estado: 409, datos: { message: 'Esa hora se tomó.' } }) },
        ),
      ),
    ).rejects.toThrow('Esa hora se tomó.');
    const q = await pool.query('SELECT status FROM suggestions WHERE id = $1', [id]);
    expect(q.rows[0].status).toBe('pending');
  });

  it('una sugerencia sin acción no se puede aplicar', async () => {
    const id = await guardar(null);
    await expect(
      withTenant(pool, tenant, (c) =>
        aplicarAccionDeLaSugerencia(
          c,
          { tenantId: tenant, suggestionId: id, permisos: PERMISOS, modulosActivos: MODULOS },
          { llamarApi: async () => ({ ok: true, estado: 200, datos: {} }) },
        ),
      ),
    ).rejects.toThrow(/no trae una acción/);
  });

  it('una acción que ya no se puede proponer tampoco se aplica', async () => {
    // La fila pudo quedar de una versión en la que esa acción sí se proponía.
    const id = await guardar({ herramienta: 'platform.apagarModulo', argumentos: {} });
    await expect(
      withTenant(pool, tenant, (c) =>
        aplicarAccionDeLaSugerencia(
          c,
          { tenantId: tenant, suggestionId: id, permisos: new Set(['platform.manage']), modulosActivos: new Set(['platform']) },
          { llamarApi: async () => ({ ok: true, estado: 200, datos: {} }) },
        ),
      ),
    ).rejects.toThrow(/no trae una acción/);
  });

  it('el CHECK de la base rechaza una acción sin herramienta', async () => {
    await expect(guardar({ argumentos: { a: 1 } })).rejects.toThrow(/accion_con_herramienta/);
  });
});
