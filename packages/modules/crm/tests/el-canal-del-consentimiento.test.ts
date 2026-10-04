import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createContact, registerOptIn } from '../application/contacts';
import { getContactFicha } from '../application/activities';

/**
 * El consentimiento tiene tres partes y se mostraba una (#696).
 *
 * `.claude/rules/negocio.md`, textual: «opt-in registrado (fecha, canal,
 * evidencia)». Las tres se guardaban desde el principio —`registerOptIn` escribe
 * las tres columnas— y `rowToContact` mapeaba solo la fecha. La ficha decía «dio su
 * consentimiento» sin poder decir **a qué** consintió.
 *
 * Y no son equivalentes: quien lo dio por el formulario del sitio no autorizó
 * recibir WhatsApp. El día que alguien reclame —«yo nunca autoricé que me
 * escribieran»— la evidencia para contestarle estaba escrita en la base y sin forma
 * de mostrarla. Una evidencia que no se puede mostrar no es evidencia.
 */
let pool: Pool;
let tenant: string;

beforeAll(async () => {
  pool = createPool();
  await runMigrations(pool);
  tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('CRM opt-in canal') RETURNING id")).rows[0].id;
});
afterAll(async () => pool.end());

const en = <T,>(f: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenant, f);

describe('el canal y la evidencia del consentimiento (#696)', () => {
  it('dos contactos con la MISMA fecha y canales distintos no se ven iguales', async () => {
    const web = await en((c) => createContact(c, { tenantId: tenant, phone: '+56990000001' }));
    const wa = await en((c) => createContact(c, { tenantId: tenant, phone: '+56990000002' }));
    await en((c) =>
      registerOptIn(c, {
        tenantId: tenant,
        contactId: web.id,
        channel: 'formulario del sitio',
        evidence: 'casilla marcada el 12/09 en /contacto, IP 190.x',
      }),
    );
    await en((c) =>
      registerOptIn(c, {
        tenantId: tenant,
        contactId: wa.id,
        channel: 'whatsapp',
        evidence: 'escribió "acepto" el 12/09',
      }),
    );

    const unoWeb = (await en((c) => getContactFicha(c, tenant, web.id))).contact;
    const unoWa = (await en((c) => getContactFicha(c, tenant, wa.id))).contact;

    // Ésta es la propiedad del issue: antes los dos devolvían solo `optInAt` y
    // eran indistinguibles.
    expect(unoWeb.opt_in_channel).toBe('formulario del sitio');
    expect(unoWa.opt_in_channel).toBe('whatsapp');
    expect(unoWeb.opt_in_channel).not.toBe(unoWa.opt_in_channel);
  });

  it('la evidencia sale completa, no recortada', async () => {
    // Es un texto para mostrarle a quien reclama: recortarlo lo vuelve inútil.
    const k = await en((c) => createContact(c, { tenantId: tenant, phone: '+56990000003' }));
    const evidencia = 'casilla marcada el 12/09/2026 en https://ejemplo.cl/contacto, IP 190.1.2.3, user-agent Chrome 140';
    await en((c) => registerOptIn(c, { tenantId: tenant, contactId: k.id, channel: 'formulario del sitio', evidence: evidencia }));
    expect((await en((c) => getContactFicha(c, tenant, k.id))).contact.opt_in_evidence).toBe(evidencia);
  });

  it('un contacto sin opt-in no inventa canal ni evidencia', async () => {
    // Importado por CSV: nace SIN opt-in, y eso tiene que verse como ausencia y no
    // como una cadena vacía que la pantalla muestre como si fuera un dato.
    const k = await en((c) => createContact(c, { tenantId: tenant, phone: '+56990000004', origin: 'importado' }));
    const leido = (await en((c) => getContactFicha(c, tenant, k.id))).contact;
    expect(leido.opt_in_at).toBeNull();
    expect(leido.opt_in_channel).toBeNull();
    expect(leido.opt_in_evidence).toBeNull();
  });
});
