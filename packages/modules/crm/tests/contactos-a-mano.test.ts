import { contactoDeLaFicha } from '../application/contacts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  agregarContactoAMano,
  ContactoDuplicado,
  createContact,
  listContacts,
  optOut,
  permisoParaEscribirle,
  registerOptIn,
  TelefonoInvalido,
  type ContactOrigin,
  type PermisoParaEscribirle,
} from '../application/contacts';
import { InvalidListQuery } from '../application/list-cursor';

/**
 * El contacto agregado a mano y los filtros de la lista (#1395).
 *
 * Dos cosas se prueban acá y en ningún otro lado:
 *
 *  1. Que el alta a mano nace SIN permiso para escribirle. Es la promesa de
 *     SPEC §8 en su forma más fácil de romper: alguien agrega a un cliente «para
 *     tenerlo anotado» y si naciera con permiso, la primera campaña le escribe
 *     a una persona que nunca dijo nada.
 *  2. Que el SQL de `filter[permiso]` y `permisoParaEscribirle` dicen LO MISMO.
 *     La regla de consentimiento existía como función; copiarla a SQL era la
 *     tentación, y dos copias de una regla de consentimiento terminan
 *     diciendo cosas distintas — la que miente es la que se ve.
 */

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;

/** Todos los contactos de la tabla de casos, con el permiso que les quedó. */
const creados: Array<{ id: string; origin: ContactOrigin; permiso: PermisoParaEscribirle }> = [];

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iaxti_app') THEN
        CREATE ROLE iaxti_app LOGIN PASSWORD 'iaxti_app';
      END IF;
    END $$
  `);
  await admin.query('GRANT USAGE ON SCHEMA public TO iaxti_app');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, companies, tags, contact_tags, custom_fields TO iaxti_app',
  );
  await admin.query('GRANT SELECT, INSERT ON audit_log TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  tenantA = (await admin.query("INSERT INTO tenants (name) VALUES ('a-mano-a') RETURNING id")).rows[0].id;
  tenantB = (await admin.query("INSERT INTO tenants (name) VALUES ('a-mano-b') RETURNING id")).rows[0].id;

  // La tabla de casos: canal o no canal × opt-in sí/no × baja sí/no. Son los
  // mismos ejes que lee `permisoParaEscribirle`, sin ningún caso de más.
  let n = 0;
  for (const origin of ['whatsapp', 'webchat', 'instagram', 'messenger', 'importado', 'manual'] as const) {
    for (const [conOptIn, conBaja] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const phone = `+569${String(71200000 + n)}`;
      n += 1;
      const { id } = await withTenant(app, tenantA, (c) =>
        createContact(c, { tenantId: tenantA, phone, name: `Caso ${origin} ${n}`, origin }),
      );
      // El estado se arma con los casos de uso del consentimiento, no con
      // UPDATE directo: opt-in con evidencia y baja son SUS caminos.
      if (conOptIn) {
        await withTenant(app, tenantA, (c) =>
          registerOptIn(c, { tenantId: tenantA, contactId: id, channel: 'formulario', evidence: 'checkeo en caja' }),
        );
      }
      if (conBaja) {
        await withTenant(app, tenantA, (c) =>
          optOut(c, { tenantId: tenantA, contactId: id, reason: 'prueba' }),
        );
      }
      const fila = await withTenant(app, tenantA, (c) =>
        c.query('SELECT opt_in_at, opted_out_at, origin FROM contacts WHERE id = $1', [id]),
      );
      creados.push({
        id,
        origin,
        permiso: permisoParaEscribirle({
          optInAt: fila.rows[0].opt_in_at,
          optedOutAt: fila.rows[0].opted_out_at,
          origin: fila.rows[0].origin,
        }),
      });
    }
  }
});

afterAll(async () => {
  await app.end();
  for (const t of [tenantA, tenantB]) {
    await admin.query('DELETE FROM contact_identities WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
  }
  // La auditoría es append-only y referencia al tenant: los tenants quedan.
  await admin.end();
});

describe('agregarContactoAMano (#1395)', () => {
  it('crea con origen manual, teléfono normalizado y SIN permiso para escribirle', async () => {
    const actor = '11111111-1111-4111-8111-111111111111';
    const contacto = await withTenant(app, tenantA, (c) =>
      agregarContactoAMano(c, {
        tenantId: tenantA,
        phone: '9 8123 4567',
        name: 'Rosa Vidal',
        email: 'rosa@ejemplo.cl',
        actor,
      }),
    );
    expect(contacto).toMatchObject({
      phone: '+56981234567',
      name: 'Rosa Vidal',
      email: 'rosa@ejemplo.cl',
      origin: 'manual',
      opt_in_at: null,
      opted_out_at: null,
    });
    // La misma proyección que la ficha: company_id y company_name viajan,
    // porque quien crea el contacto va a volver a verlo al abrir su ficha.
    expect(Object.keys(contacto)).toEqual(
      expect.arrayContaining(['id', 'company_id', 'company_name', 'created_at', 'last_activity_at']),
    );
    const enLaLista = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { q: '+56981234567' }));
    expect(enLaLista.items).toHaveLength(1);
    // El punto entero del caso de uso: anotado ≠ autorizado.
    expect(enLaLista.items[0].permiso).toBe('sin_permiso');
  });

  it('audita contact.created en la misma transacción, sin teléfono ni nombre en el metadata', async () => {
    const actor = '22222222-2222-4222-8222-222222222222';
    const contacto = await withTenant(app, tenantA, (c) =>
      agregarContactoAMano(c, { tenantId: tenantA, phone: '+56981234500', name: 'Secreto Nombre', actor }),
    );
    const audit = await admin.query(
      'SELECT actor, actor_kind, action, resource, resource_id, result, metadata FROM audit_log WHERE tenant_id = $1 AND resource_id = $2',
      [tenantA, contacto.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actor,
      actor_kind: 'user',
      action: 'contact.created',
      resource: 'contact',
      result: 'ok',
    });
    // El metadata lleva el origen y NADA más: el teléfono y el nombre ya viven
    // en la fila del contacto, y repetirlos acá es copiar PII al libro que
    // más gente puede leer.
    expect(audit.rows[0].metadata).toEqual({ origin: 'manual' });
    expect(JSON.stringify(audit.rows[0])).not.toContain('Secreto');
    expect(JSON.stringify(audit.rows[0])).not.toContain('+56981234500');
    // El evento del outbox es el de siempre: el resto del sistema no tiene
    // por qué distinguir un contacto manual de uno importado.
    const evento = await admin.query(
      "SELECT 1 FROM outbox WHERE tenant_id = $1 AND name = 'contact.created' AND payload->>'contactId' = $2",
      [tenantA, contacto.id],
    );
    expect(evento.rowCount).toBe(1);
  });

  it('un teléfono inválido se rechaza con el error tipado y no escribe nada', async () => {
    const antes = await admin.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantA]);
    for (const phone of ['patito', '+569123', '']) {
      await expect(
        withTenant(app, tenantA, (c) => agregarContactoAMano(c, { tenantId: tenantA, phone, actor: 'x' })),
      ).rejects.toBeInstanceOf(TelefonoInvalido);
    }
    const despues = await admin.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [tenantA]);
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });

  it('el teléfono repetido da el id del existente y NO deja la transacción abortada', async () => {
    const existente = await withTenant(app, tenantA, (c) =>
      agregarContactoAMano(c, { tenantId: tenantA, phone: '+56981234577', actor: 'a' }),
    );
    // Dentro de la MISMA transacción: si el caso de uso dejara la transacción
    // abortada (el 23505 la aborta entera), el SELECT de abajo revienta con
    // 25P02 y esta prueba se cae — no la de la fila repetida.
    const resultado = await withTenant(app, tenantA, async (c) => {
      const fallo = agregarContactoAMano(c, { tenantId: tenantA, phone: '98123 4577', actor: 'b' });
      await expect(fallo).rejects.toBeInstanceOf(ContactoDuplicado);
      await expect(fallo).rejects.toMatchObject({ contactId: existente.id });
      // El teléfono escrito distinto normaliza al mismo E.164: es el caso real
      // de quien anota «9 8123 4577» de un cliente que ya está.
      return c.query('SELECT 1 AS viva');
    });
    expect(resultado.rows[0].viva).toBe(1);
  });

  it('dos altas en paralela con el mismo teléfono: una gana y la otra recibe su id', async () => {
    const phone = '+56981234566';
    // La transacción de la izquierda inserta SIN comprometer: la de la
    // derecha pasa su comprobación (no ve filas sin comprometer, READ
    // COMMITTED), llega al INSERT y se bloquea en el índice único hasta que
    // acá se compromete. Es la carrera de verdad, no una simulación.
    const izquierda = await app.connect();
    try {
      await izquierda.query('BEGIN');
      await izquierda.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const insertada = await izquierda.query(
        'INSERT INTO contacts (tenant_id, phone, origin) VALUES ($1, $2, $3) RETURNING id',
        [tenantA, phone, 'importado'],
      );
      const derecha = withTenant(app, tenantA, (c) =>
        agregarContactoAMano(c, { tenantId: tenantA, phone, actor: 'b' }),
      );
      await new Promise((r) => setTimeout(r, 150));
      await izquierda.query('COMMIT');
      await expect(derecha).rejects.toMatchObject({ contactId: insertada.rows[0].id });
    } finally {
      await izquierda.query('ROLLBACK').catch(() => {});
      izquierda.release();
    }
  });

  it('el mismo teléfono en OTRO negocio se puede agregar: RLS no lo ve', async () => {
    // En A «+56981234567» ya existe (Rosa); en B acaba de nacer: la cartera de
    // cada negocio es distinta y el índice único es por (tenant, phone).
    const enB = await withTenant(app, tenantB, (c) =>
      agregarContactoAMano(c, { tenantId: tenantB, phone: '+56981234567', actor: 'b' }),
    );
    expect(enB.phone).toBe('+56981234567');
    const listaB = await withTenant(app, tenantB, (c) => listContacts(c, tenantB, {}));
    // Desde B no se ve UNO solo de los contactos de A.
    expect(listaB.items).toHaveLength(1);
    expect(listaB.items[0].id).toBe(enB.id);
  });
});

describe('filter[permiso]: el SQL dice lo mismo que permisoParaEscribirle', () => {
  it('la tabla de casos completa, para cada valor del filtro', async () => {
    // Lo esperado sale de la FUNCIÓN sobre la lista completa; lo actual, del
    // SQL del filtro. Si algún día se separan, un caso de esta tabla queda
    // del lado que no corresponde y acá se ve.
    const todos = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { limit: 100 }));
    const ids = new Set(todos.items.map((i) => i.id));
    for (const c of creados) {
      expect(ids.has(c.id), `el caso ${c.origin}/${c.permiso} no está en la lista`).toBe(true);
    }
    // La tabla de casos está completa y cubre los cuatro motivos de la
    // función — «baja» incluso sobre un opt-in anterior.
    expect(creados).toHaveLength(24);
    expect(new Set(creados.map((c) => c.permiso))).toEqual(
      new Set(['baja', 'opt_in', 'escribio_primero', 'sin_permiso']),
    );

    const porMotivo = (f: (p: PermisoParaEscribirle) => boolean) =>
      new Set(todos.items.filter((i) => f(i.permiso)).map((i) => i.id));
    const esperados: Record<string, Set<string>> = {
      puede: porMotivo((p) => p === 'opt_in' || p === 'escribio_primero'),
      sin_permiso: porMotivo((p) => p === 'sin_permiso'),
      baja: porMotivo((p) => p === 'baja'),
    };
    for (const permiso of ['puede', 'sin_permiso', 'baja'] as const) {
      const pagina = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { permiso, limit: 100 }));
      expect(
        new Set(pagina.items.map((i) => i.id)),
        `filter[permiso]=${permiso} no devolvió exactamente los que permisoParaEscribirle dice`,
      ).toEqual(esperados[permiso]);
    }
    // Y la FICHA dice lo mismo que la lista para cada caso: el encabezado de
    // la ficha no puede contradecir al envío.
    for (const c of creados) {
      const ficha = await withTenant(app, tenantA, (cl) => contactoDeLaFicha(cl, tenantA, c.id));
      expect(ficha?.permiso, `ficha de ${c.origin}/${c.permiso}`).toBe(c.permiso);
    }
  });

  it('un valor desconocido se rechaza y no se filtra a ciegas', async () => {
    for (const permiso of ['OPT_IN', 'escribio_primero', 'cancelado']) {
      await expect(withTenant(app, tenantA, (c) => listContacts(c, tenantA, { permiso }))).rejects.toBeInstanceOf(
        InvalidListQuery,
      );
    }
  });
});

describe('filter[origen] (#1395)', () => {
  it('filtra por origen y se combina con la búsqueda q', async () => {
    const todos = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { limit: 100 }));
    for (const origin of ['whatsapp', 'webchat', 'instagram', 'messenger', 'importado', 'manual'] as const) {
      const pagina = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { origen: origin, limit: 100 }));
      expect(
        new Set(pagina.items.map((i) => i.id)),
        `filter[origen]=${origin}`,
      ).toEqual(new Set(todos.items.filter((i) => i.origin === origin).map((i) => i.id)));
    }
    // Junto con q: los dos filtros se aplican a la vez, no se pisan.
    const buscados = await withTenant(app, tenantA, (c) =>
      listContacts(c, tenantA, { origen: 'whatsapp', q: 'Caso whatsapp', limit: 100 }),
    );
    expect(new Set(buscados.items.map((i) => i.id))).toEqual(
      new Set(
        todos.items.filter((i) => i.origin === 'whatsapp' && (i.name ?? '').includes('Caso whatsapp')).map((i) => i.id),
      ),
    );
    expect(buscados.items.length).toBeGreaterThan(0);
  });

  it('un origen desconocido se rechaza', async () => {
    await expect(
      withTenant(app, tenantA, (c) => listContacts(c, tenantA, { origen: 'telegram' })),
    ).rejects.toBeInstanceOf(InvalidListQuery);
  });
});

describe('el cursor lleva el filtro en el scope', () => {
  it('un cursor emitido CON filtro no sirve sin él ni con otro filtro', async () => {
    const pagina = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { permiso: 'puede', limit: 2 }));
    expect(pagina.nextCursor).toBeTruthy();
    // Con el MISMO filtro, sigue paginando.
    const segunda = await withTenant(app, tenantA, (c) =>
      listContacts(c, tenantA, { permiso: 'puede', limit: 2, cursor: pagina.nextCursor! }),
    );
    expect(segunda.items.length).toBeGreaterThan(0);
    expect(segunda.items.map((i) => i.id)).not.toEqual(pagina.items.map((i) => i.id));
    // Sin el filtro: el cursor es de OTRA búsqueda.
    await expect(
      withTenant(app, tenantA, (c) => listContacts(c, tenantA, { cursor: pagina.nextCursor! })),
    ).rejects.toBeInstanceOf(InvalidListQuery);
    // Con otro filtro distinto, tampoco.
    await expect(
      withTenant(app, tenantA, (c) => listContacts(c, tenantA, { permiso: 'baja', cursor: pagina.nextCursor! })),
    ).rejects.toBeInstanceOf(InvalidListQuery);
    await expect(
      withTenant(app, tenantA, (c) => listContacts(c, tenantA, { origen: 'manual', cursor: pagina.nextCursor! })),
    ).rejects.toBeInstanceOf(InvalidListQuery);
  });

  it('un cursor emitido SIN filtro no sirve con uno', async () => {
    const pagina = await withTenant(app, tenantA, (c) => listContacts(c, tenantA, { limit: 2 }));
    expect(pagina.nextCursor).toBeTruthy();
    await expect(
      withTenant(app, tenantA, (c) => listContacts(c, tenantA, { permiso: 'puede', cursor: pagina.nextCursor! })),
    ).rejects.toBeInstanceOf(InvalidListQuery);
  });
});
