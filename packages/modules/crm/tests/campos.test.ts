import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
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

// Tipado de verdad y no con `as never` (#507): el casteo era para callar al
// compilador, y callaba TODO el archivo — cada resultado salía `unknown`, así
// que ningún `expect` sobre una propiedad estaba comprobando nada.
const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

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

describe('el rastro de los campos propios (#534)', () => {
  // Un campo propio puede guardar datos personales —el convenio de salud, el
  // número de ficha—, así que quién lo declaró y quién lo borró es justo lo
  // que el libro de auditoría tiene que contestar, y el archivo entero no
  // tenía un solo `writeAudit`.
  let convenio: string;

  it('declarar un campo queda en audit_log con quién lo declaró', async () => {
    const campo = await en((c) =>
      createCustomField(c, {
        tenantId: tenant,
        entity: 'contact',
        label: 'Convenio',
        type: 'texto',
        visibleIa: false,
        actor: 'u-sofia',
        requestId: 'req-534',
      }),
    );
    convenio = campo.id;

    const r = await admin.query(
      `SELECT actor, actor_kind, action, resource, result, request_id, metadata
         FROM audit_log WHERE tenant_id = $1 AND resource_id = $2`,
      [tenant, campo.id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe('u-sofia');
    expect(r.rows[0].actor_kind).toBe('user');
    expect(r.rows[0].action).toBe('fields.create');
    expect(r.rows[0].resource).toBe('custom_field');
    expect(r.rows[0].result).toBe('ok');
    expect(r.rows[0].request_id).toBe('req-534');
    // `visibleIa` es el que decide qué sale del negocio hacia el asistente:
    // sin él en el metadata, el registro no dice qué se decidió.
    expect(r.rows[0].metadata).toMatchObject({
      entity: 'contact',
      key: 'convenio',
      label: 'Convenio',
      type: 'texto',
      required: false,
      visibleIa: false,
    });
  });

  it('un campo rechazado no deja rastro: el ROLLBACK se lleva la fila', async () => {
    // `withTenant` es una transacción: la entrada de auditoría va DESPUÉS del
    // INSERT y muere con él. Si alguien moviera el `writeAudit` antes, este
    // segundo intento dejaría un «se declaró Convenio» de un campo que no se
    // declaró.
    await expect(
      en((c) =>
        createCustomField(c, {
          tenantId: tenant,
          entity: 'contact',
          label: 'Convenio',
          type: 'texto',
          actor: 'u-sofia',
        }),
      ),
    ).rejects.toThrow(/Ya existe un campo/);

    const r = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND action = 'fields.create' AND metadata ->> 'key' = 'convenio'`,
      [tenant],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it('borrar registra la definición completa y a cuántas fichas les quitó el piso', async () => {
    await en((c) =>
      updateContact(c, {
        tenantId: tenant,
        contactId: contacto,
        custom: { ficha: 42, convenio: 'Caja Los Andes' },
      }),
    );

    await en((c) => deleteCustomField(c, { tenantId: tenant, fieldId: convenio, actor: 'u-sofia' }));

    const r = await admin.query(
      `SELECT actor, action, metadata FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2 AND action = 'fields.delete'`,
      [tenant, convenio],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe('u-sofia');
    // La definición ya no existe en la base: si el metadata no la repitiera,
    // el registro sería un id que no resuelve a nada.
    expect(r.rows[0].metadata).toMatchObject({
      entity: 'contact',
      key: 'convenio',
      label: 'Convenio',
      visibleIa: false,
    });
    // «Se borró el campo Convenio» no dice si se perdió el dato de una ficha
    // o de tres mil.
    expect(r.rows[0].metadata.fichasConValor).toBe(1);
  });

  it('borrar un campo que no existe no deja rastro de nada', async () => {
    const antes = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'fields.delete'`,
      [tenant],
    );
    await expect(
      en((c) => deleteCustomField(c, { tenantId: tenant, fieldId: convenio, actor: 'u-sofia' })),
    ).rejects.toThrow(/no existe en este negocio/);
    const despues = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'fields.delete'`,
      [tenant],
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
  });
});

describe('exportación de contactos a CSV (issue 248)', () => {
  it('trae las columnas base, las etiquetas y los campos declarados', async () => {
    const { exportarContactos } = await import('../application/exportar-contactos');
    const { csv, filas, columnas } = await en((c) =>
      exportarContactos(c, { tenantId: tenant }),
    );

    // Los campos personalizados son columnas propias, no un JSON en una celda.
    expect(columnas).toContain('Ficha');
    expect(columnas[0]).toBe('nombre');
    expect(filas).toBe(1);

    const [cabecera, fila] = csv.split('\n');
    expect(cabecera).toContain('"telefono"');
    expect(fila).toContain('"Rosa"');
    expect(fila).toContain('"+56955550101"');
    expect(fila).toContain('"42"'); // el campo declarado, en su columna
  });

  it('un texto con coma o comillas no corre las columnas', async () => {
    const { exportarContactos } = await import('../application/exportar-contactos');
    await admin.query(
      `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Pérez, Ana "la jefa"', '+56955550102', 'manual')`,
      [tenant],
    );
    const { csv } = await en((c) => exportarContactos(c, { tenantId: tenant }));
    const lineas = csv.split('\n');
    // Una fila por contacto: si las comillas corrieran las columnas, esta
    // fila se partiría en dos.
    expect(lineas).toHaveLength(3);
    expect(csv).toContain('"Pérez, Ana ""la jefa"""');
  });
});
