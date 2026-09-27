import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { isOptOutMessage, normalizePhone, normalizeRut } from '../domain/validation';
import {
  canReceiveBusinessInitiated,
  createContact,
  ensureContactByIdentity,
  ensureContactByPhone,
  ensureWebContact,
  handleInboundForConsent,
  identityFor,
  linkIdentity,
  registerOptIn,
  updateContact,
} from '../application/contacts';

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let app: Pool;
let tenantA: string;
let tenantB: string;

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
  await admin.query('GRANT SELECT, INSERT, UPDATE ON contacts, contact_identities, companies, tags, contact_tags, custom_fields TO iaxti_app');
  await admin.query('GRANT INSERT ON outbox TO iaxti_app');
  app = createPool(ADMIN_URL.replace(/\/\/[^@]+@/, '//iaxti_app:iaxti_app@'));
  const a = await admin.query("INSERT INTO tenants (name) VALUES ('crm-a') RETURNING id");
  const b = await admin.query("INSERT INTO tenants (name) VALUES ('crm-b') RETURNING id");
  tenantA = a.rows[0].id;
  tenantB = b.rows[0].id;
});

afterAll(async () => {
  await app.end();
  for (const t of [tenantA, tenantB]) {
    await admin.query('DELETE FROM contacts WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM outbox WHERE tenant_id = $1', [t]);
    await admin.query('DELETE FROM tenants WHERE id = $1', [t]);
  }
  await admin.end();
});

describe('validaciones de dominio (SPEC §8)', () => {
  it('normaliza teléfonos chilenos a E.164 y rechaza los ambiguos', () => {
    expect(normalizePhone('+56 9 1234 5678')).toBe('+56912345678');
    expect(normalizePhone('9 1234 5678')).toBe('+56912345678');
    expect(normalizePhone('091234-5678')).toBe('+56912345678');
    expect(normalizePhone('56912345678')).toBe('+56912345678');
    expect(normalizePhone('+14085551234')).toBe('+14085551234');
    expect(() => normalizePhone('12345')).toThrow(/Teléfono inválido/);
  });

  it('valida el RUT con dígito verificador y lo normaliza', () => {
    expect(normalizeRut('11.111.111-1')).toBe('11111111-1');
    expect(normalizeRut('11111111 1')).toBe('11111111-1');
    expect(() => normalizeRut('11111111-2')).toThrow(/dígito verificador/);
    expect(() => normalizeRut('abc')).toThrow(/RUT inválido/);
  });

  it('detecta el opt-out en sus variantes y no en frases normales', () => {
    for (const frase of ['BASTA', 'stop', 'No me escriban', 'no quiero más mensajes', 'desuscribirme']) {
      expect(isOptOutMessage(frase)).toBe(true);
    }
    for (const frase of ['perfecto, gracias', 'me interesa el producto', 'hablemos mañana']) {
      expect(isOptOutMessage(frase)).toBe(false);
    }
  });
});

describe('contactos (rol de aplicación, RLS activa)', () => {
  it('ensureContactByPhone crea una vez y encuentra después, con el teléfono normalizado', async () => {
    const primero = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '9 8765 4321', origin: 'whatsapp' }),
    );
    expect(primero.created).toBe(true);
    expect(primero.contact.phone).toBe('+56987654321');

    const segundo = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56 9 8765-4321', origin: 'whatsapp' }),
    );
    expect(segundo.created).toBe(false);
    expect(segundo.contact.id).toBe(primero.contact.id);

    const evento = await admin.query(
      "SELECT count(*)::int AS n FROM outbox WHERE name = 'contact.created' AND tenant_id = $1",
      [tenantA],
    );
    expect(evento.rows[0].n).toBe(1);
  });

  it('el mismo teléfono puede existir en otro tenant (aislamiento)', async () => {
    const enB = await withTenant(app, tenantB, (c) =>
      ensureContactByPhone(c, { tenantId: tenantB, phone: '+56987654321', origin: 'webchat' }),
    );
    expect(enB.created).toBe(true);

    const visiblesA = await withTenant(app, tenantA, (c) =>
      c.query('SELECT count(*)::int AS n FROM contacts'),
    );
    expect(visiblesA.rows[0].n).toBe(1);
  });

  it('"BASTA" marca opt-out automático, publica el evento y bloquea envíos del negocio', async () => {
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56911112222', origin: 'whatsapp' }),
    );
    expect(await withTenant(app, tenantA, (c) => canReceiveBusinessInitiated(c, tenantA, contact.id))).toBe(true);

    const res = await withTenant(app, tenantA, (c) =>
      handleInboundForConsent(c, { tenantId: tenantA, contactId: contact.id, text: 'ya BASTA de mensajes' }),
    );
    expect(res.optedOut).toBe(true);
    expect(await withTenant(app, tenantA, (c) => canReceiveBusinessInitiated(c, tenantA, contact.id))).toBe(false);

    const evento = await admin.query(
      "SELECT 1 FROM outbox WHERE name = 'contact.opted_out' AND tenant_id = $1",
      [tenantA],
    );
    expect(evento.rowCount).toBe(1);
  });

  it('el opt-in con evidencia restaura el consentimiento', async () => {
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56911112222', origin: 'whatsapp' }),
    );
    await withTenant(app, tenantA, (c) =>
      registerOptIn(c, { tenantId: tenantA, contactId: contact.id, channel: 'whatsapp', evidence: 'dijo "sí, avísenme" el 2026-09-14' }),
    );
    expect(await withTenant(app, tenantA, (c) => canReceiveBusinessInitiated(c, tenantA, contact.id))).toBe(true);
  });

  it('un contacto importado nace sin opt-in y no recibe iniciados por el negocio', async () => {
    const importado = await withTenant(app, tenantA, (c) =>
      createContact(c, { tenantId: tenantA, phone: '+56933334444', name: 'Del Excel', origin: 'importado' }),
    );
    expect(await withTenant(app, tenantA, (c) => canReceiveBusinessInitiated(c, tenantA, importado.id))).toBe(false);
  });

  it('updateContact valida RUT, mergea custom y publica contact.updated', async () => {
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56955556666', origin: 'manual' }),
    );
    const actualizado = await withTenant(app, tenantA, (c) =>
      updateContact(c, {
        tenantId: tenantA,
        contactId: contact.id,
        name: 'Clienta Real',
        rut: '11.111.111-1',
        custom: { comuna: 'Ñuñoa' },
      }),
    );
    expect(actualizado.rut).toBe('11111111-1');
    expect(actualizado.custom).toEqual({ comuna: 'Ñuñoa' });
    await expect(
      withTenant(app, tenantA, (c) =>
        updateContact(c, { tenantId: tenantA, contactId: contact.id, rut: '11111111-2' }),
      ),
    ).rejects.toThrow(/dígito verificador/);
  });

  it('mandar null BORRA; no mandar el campo lo deja como estaba (#480)', async () => {
    // `name` e `email` iban por COALESCE: borrarlos era imposible, y el
    // contacto que pidió que le sacaran el correo se quedaba con él
    // mientras la pantalla parecía no hacer nada.
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureContactByPhone(c, { tenantId: tenantA, phone: '+56955557777', origin: 'manual' }),
    );
    await withTenant(app, tenantA, (c) =>
      updateContact(c, {
        tenantId: tenantA,
        contactId: contact.id,
        name: 'Con correo',
        email: 'antes@ejemplo.cl',
      }),
    );

    const sinCorreo = await withTenant(app, tenantA, (c) =>
      updateContact(c, { tenantId: tenantA, contactId: contact.id, email: null }),
    );
    expect(sinCorreo.email).toBeNull();
    // Y lo que no se mandó sigue donde estaba.
    expect(sinCorreo.name).toBe('Con correo');

    const sinNombre = await withTenant(app, tenantA, (c) =>
      updateContact(c, { tenantId: tenantA, contactId: contact.id, name: null }),
    );
    expect(sinNombre.name).toBeNull();
  });
});

describe('la identidad de WhatsApp es OPACA, no un teléfono', () => {
  // Quien adoptó nombre de usuario y escondió su número llega con un BSUID, y
  // un grupo llega con un JID. Antes los dos se forzaban por `normalizePhone`,
  // que lanzaba; y como el webhook ya respondió 200, el canal daba el mensaje
  // por entregado y no reintentaba nunca: se perdía para siempre y en la
  // bandeja no aparecía nada.
  const BSUID = 'US.13491208655302741918';
  const JID_DE_GRUPO = '120363001122334455@g.us';

  it('un BSUID de WhatsApp crea el contacto sin teléfono y queda como su identidad', async () => {
    const primero = await withTenant(app, tenantA, (c) =>
      ensureContactByIdentity(c, {
        tenantId: tenantA,
        channel: 'whatsapp',
        identity: BSUID,
        origin: 'whatsapp',
        name: 'Quien esconde su número',
      }),
    );
    expect(primero.created).toBe(true);
    // No se le inventa un teléfono: no lo tenemos.
    expect(primero.contact.phone).toBeNull();
    expect(primero.contact.name).toBe('Quien esconde su número');

    // Y se le puede responder: la identidad del canal es por donde escribió.
    expect(
      await withTenant(app, tenantA, (c) =>
        identityFor(c, { tenantId: tenantA, contactId: primero.contact.id, channel: 'whatsapp' }),
      ),
    ).toBe(BSUID);

    // Idempotente: el segundo mensaje del mismo no abre otra ficha.
    const segundo = await withTenant(app, tenantA, (c) =>
      ensureContactByIdentity(c, {
        tenantId: tenantA,
        channel: 'whatsapp',
        identity: BSUID,
        origin: 'whatsapp',
      }),
    );
    expect(segundo.created).toBe(false);
    expect(segundo.contact.id).toBe(primero.contact.id);
  });

  it('un JID de grupo tampoco se fuerza por el teléfono', async () => {
    const grupo = await withTenant(app, tenantA, (c) =>
      ensureContactByIdentity(c, {
        tenantId: tenantA,
        channel: 'whatsapp',
        identity: JID_DE_GRUPO,
        origin: 'whatsapp',
      }),
    );
    expect(grupo.created).toBe(true);
    expect(grupo.contact.phone).toBeNull();
  });

  it('cuando la identidad SÍ es un teléfono se sigue normalizando a E.164', async () => {
    // Esto es lo que no se puede perder al arreglar lo de arriba: el dedupe
    // histórico de WhatsApp vive en el teléfono normalizado.
    const suelto = await withTenant(app, tenantA, (c) =>
      ensureContactByIdentity(c, {
        tenantId: tenantA,
        channel: 'whatsapp',
        identity: '9 8765 1111',
        origin: 'whatsapp',
      }),
    );
    expect(suelto.contact.phone).toBe('+56987651111');

    const mismo = await withTenant(app, tenantA, (c) =>
      ensureContactByIdentity(c, {
        tenantId: tenantA,
        channel: 'whatsapp',
        identity: '+56 9 8765-1111',
        origin: 'whatsapp',
      }),
    );
    expect(mismo.created).toBe(false);
    expect(mismo.contact.id).toBe(suelto.contact.id);
  });
});

describe('no se borra el ÚLTIMO identificador del contacto', () => {
  it('el del webchat que solo dejó su correo no se queda sin nada', async () => {
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureWebContact(c, {
        tenantId: tenantA,
        name: 'Visitante',
        email: 'visitante@ejemplo.cl',
      }),
    );
    expect(contact.phone).toBeNull();
    expect(contact.email).toBe('visitante@ejemplo.cl');

    const rechazo = withTenant(app, tenantA, (c) =>
      updateContact(c, { tenantId: tenantA, contactId: contact.id, email: null }),
    );
    await expect(rechazo).rejects.toThrow(/lo único con que reconocemos/);
    await expect(rechazo).rejects.toMatchObject({ code: 'ULTIMO_IDENTIFICADOR' });

    // Y el correo sigue ahí: la ficha no quedó huérfana a medias.
    const despues = await admin.query('SELECT email FROM contacts WHERE id = $1', [contact.id]);
    expect(despues.rows[0].email).toBe('visitante@ejemplo.cl');
  });

  it('con otra identidad viva el correo sí se puede borrar', async () => {
    const { contact } = await withTenant(app, tenantA, (c) =>
      ensureWebContact(c, {
        tenantId: tenantA,
        name: 'Visitante con canal',
        email: 'con-canal@ejemplo.cl',
      }),
    );
    await withTenant(app, tenantA, (c) =>
      linkIdentity(c, {
        tenantId: tenantA,
        contactId: contact.id,
        channel: 'webchat',
        identity: 'sesion-web-abc',
      }),
    );

    const sinCorreo = await withTenant(app, tenantA, (c) =>
      updateContact(c, { tenantId: tenantA, contactId: contact.id, email: null }),
    );
    expect(sinCorreo.email).toBeNull();
  });
});
