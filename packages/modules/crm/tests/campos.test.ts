import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  llaveDeCampo,
  paraLaIa,
  validarCustom,
} from '../application/campos';
import { updateContact } from '../application/contacts';

// Campos personalizados (issue 248): la tabla estaba desde el primer día con
// los seis tipos, y no había forma de declarar ninguno.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let contacto: string;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('campos-test') RETURNING id");
  tenant = t.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Rosa', '+56955550101', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

const en = <T>(fn: (c: never) => Promise<T>) => withTenant(admin, tenant, fn as never);

describe('campos personalizados', () => {
  it('la llave se normaliza: así viaja en custom y en las herramientas del copiloto', () => {
    expect(llaveDeCampo('Número de ficha')).toBe('numero_de_ficha');
    expect(llaveDeCampo('  ¿Es socio?  ')).toBe('es_socio');
    expect(() => llaveDeCampo('  ')).toThrow(/nombre/);
  });

  it('se declaran por entidad y tipo; una lista sin opciones se rechaza', async () => {
    await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'contact', label: 'Talla', type: 'lista', options: ['S', 'M', 'L'] }),
    );
    await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'contact', label: 'Ficha', type: 'numero', required: true }),
    );
    await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'contact', label: 'Nota interna', type: 'texto', visibleIa: false }),
    );

    await expect(
      en((c) => createCustomField(c, { tenantId: tenant, entity: 'contact', label: 'Vacía', type: 'lista' })),
    ).rejects.toThrow(/opciones/);
    await expect(
      en((c) => createCustomField(c, { tenantId: tenant, entity: 'ornitorrinco', label: 'X', type: 'texto' })),
    ).rejects.toThrow(/campos personalizados para/);

    expect(await en((c) => listCustomFields(c, tenant, 'contact'))).toHaveLength(3);
  });

  it('valida tipo, obligatorio y opciones al guardar el contacto', async () => {
    await expect(
      en((c) => updateContact(c, { tenantId: tenant, contactId: contacto, custom: { talla: 'XXL', ficha: 1 } })),
    ).rejects.toThrow(/acepta: S, M, L/);

    await expect(
      en((c) => updateContact(c, { tenantId: tenant, contactId: contacto, custom: { talla: 'M', ficha: 'hola' } })),
    ).rejects.toThrow(/número/);

    const ok = await en((c) =>
      updateContact(c, { tenantId: tenant, contactId: contacto, custom: { talla: 'M', ficha: '42' } }),
    );
    // El número entra como número, no como el texto que vino del formulario.
    expect(ok.custom.ficha).toBe(42);
  });

  it('lo que el negocio ya tenía guardado sigue pasando', async () => {
    // Declarar un campo nuevo no puede romper todas las fichas viejas.
    const ok = await en((c) =>
      updateContact(c, { tenantId: tenant, contactId: contacto, custom: { talla: 'M', ficha: 42, patente: 'AB1234' } }),
    );
    expect(ok.custom.patente).toBe('AB1234');
  });

  it('el copiloto solo ve los campos marcados visibles', async () => {
    const campos = await en((c) => listCustomFields(c, tenant, 'contact'));
    const visible = paraLaIa(campos, { talla: 'M', ficha: 42, nota_interna: 'no mostrar' });
    expect(visible).toEqual({ Talla: 'M', Ficha: 42 });
  });

  it('quitar la definición NO borra lo que el negocio guardó', async () => {
    const campos = await en((c) => listCustomFields(c, tenant, 'contact'));
    const talla = campos.find((f) => f.key === 'talla')!;
    await en((c) => deleteCustomField(c, { tenantId: tenant, fieldId: talla.id }));
    const fila = await admin.query('SELECT custom FROM contacts WHERE id = $1', [contacto]);
    expect(fila.rows[0].custom.talla).toBe('M');
  });

  it('un campo obligatorio vacío se rechaza con su nombre', () => {
    expect(() =>
      validarCustom(
        [{ id: '1', entity: 'contact', key: 'rut_empresa', label: 'RUT de la empresa', type: 'texto', required: true, visibleIa: true, options: [] }],
        {},
      ),
    ).toThrow(/RUT de la empresa/);
  });
});
