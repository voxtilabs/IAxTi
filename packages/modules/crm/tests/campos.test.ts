import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  llaveDeCampo,
  paraLaIa,
  updateCustomField,
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
  // número de ficha—, así que quién lo declaró, quién lo cambió y quién lo
  // borró es justo lo que el libro de auditoría tiene que contestar, y el
  // archivo entero no tenía un solo `writeAudit`.
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

    // Buscar POR `resource_id` no es un detalle de la consulta: ese id lo
    // generó la base en el INSERT, así que una entrada que lo lleva solo pudo
    // escribirse DESPUÉS de la mutación. Ésta es la prueba que se pone roja si
    // alguien mueve el `writeAudit` antes del INSERT —ahí no hay id que poner—,
    // y no la del intento rechazado, que de eso no se entera.
    const r = await admin.query(
      `SELECT actor, actor_kind, action, resource, resource_id, result, request_id, metadata
         FROM audit_log WHERE tenant_id = $1 AND resource_id = $2`,
      [tenant, campo.id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].resource_id).toBe(campo.id);
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
      options: [],
    });
  });

  it('sin actor, el libro no inventa un usuario llamado «system»', async () => {
    // El par tiene que ser coherente: `actor: 'system'` con `actorKind: 'user'`
    // deja el libro afirmando que hubo una PERSONA llamada «system», que es un
    // dato falso y se lee como verdadero. Sin actor no hubo persona.
    const campo = await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'contact', label: 'Patente', type: 'texto' }),
    );
    const r = await admin.query(
      'SELECT actor, actor_kind FROM audit_log WHERE tenant_id = $1 AND resource_id = $2',
      [tenant, campo.id],
    );
    expect(r.rows[0]).toEqual({ actor: 'system', actor_kind: 'system' });
  });

  it('el campo y su rastro caen juntos: la auditoría va en la MISMA transacción', async () => {
    // CLAUDE.md §3 pide la auditoría en la transacción de la mutación, y eso
    // solo se ve haciendo fallar la transacción DESPUÉS de que el caso de uso
    // terminó bien: ahí el ROLLBACK tiene algo que llevarse.
    //
    // Lo que esto caza —y nada más de este archivo lo caza— es un `writeAudit`
    // escrito por otra conexión: un pool propio, un `after` del caso de uso,
    // un cliente que no es el de `withTenant`. Esa fila sobrevive al ROLLBACK
    // y queda diciendo que se declaró un campo que no existe. Probado: con el
    // `writeAudit` hablando por un pool aparte, esta prueba se pone roja y las
    // otras dieciséis siguen verdes.
    //
    // El orden entre mutación y auditoría lo cuida la primera prueba, por el
    // id; un rechazo del INSERT no dice nada de ninguna de las dos cosas,
    // porque ahí el caso de uso ni llega a auditar.
    await expect(
      en(async (c) => {
        await createCustomField(c, {
          tenantId: tenant,
          entity: 'contact',
          label: 'Tarjeta de convenio',
          type: 'texto',
          actor: 'u-sofia',
        });
        throw new Error('algo se cae después de declarar el campo');
      }),
    ).rejects.toThrow(/se cae después/);

    const campos = await en((c) => listCustomFields(c, tenant, 'contact'));
    expect(campos.some((f) => f.key === 'tarjeta_de_convenio')).toBe(false);
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND metadata ->> 'key' = 'tarjeta_de_convenio'`,
      [tenant],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it('un campo repetido se rechaza con el mensaje del negocio, no con el de Postgres', async () => {
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
  });

  it('editar registra el antes y el después, y la llave no se mueve', async () => {
    // La edición es el criterio de #534 que no existía: no es que auditara mal,
    // es que no se podía corregir un campo. Y la llave NO sigue a la etiqueta:
    // es donde está guardado el valor en cada ficha.
    const campo = await en((c) =>
      createCustomField(c, {
        tenantId: tenant,
        entity: 'contact',
        label: 'Nota del convenio',
        type: 'texto',
        required: true,
        visibleIa: false,
        actor: 'u-sofia',
      }),
    );

    const editado = await en((c) =>
      updateCustomField(c, {
        tenantId: tenant,
        fieldId: campo.id,
        label: 'Convenio de salud',
        visibleIa: true,
        required: false,
        actor: 'u-marta',
        requestId: 'req-edicion',
      }),
    );
    expect(editado.key).toBe('nota_del_convenio');
    expect(editado.label).toBe('Convenio de salud');
    expect(editado.visibleIa).toBe(true);

    const r = await admin.query(
      `SELECT actor, actor_kind, action, request_id, metadata FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2 AND action = 'fields.update'`,
      [tenant, campo.id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].actor).toBe('u-marta');
    expect(r.rows[0].actor_kind).toBe('user');
    expect(r.rows[0].request_id).toBe('req-edicion');
    // El renglón que alguien va a venir a buscar es «`visibleIa` pasó de false
    // a true»: con solo el estado final no se sabe si lo cambió esta edición o
    // ya venía así.
    expect(r.rows[0].metadata).toMatchObject({
      entity: 'contact',
      key: 'nota_del_convenio',
      antes: { label: 'Nota del convenio', required: true, visibleIa: false, options: [] },
      despues: { label: 'Convenio de salud', required: false, visibleIa: true, options: [] },
    });
  });

  it('la edición no puede dejar una lista sin opciones, ni a medias', async () => {
    const lista = await en((c) =>
      createCustomField(c, {
        tenantId: tenant,
        entity: 'contact',
        label: 'Sucursal',
        type: 'lista',
        options: ['Centro', 'Mall'],
        actor: 'u-sofia',
      }),
    );
    await expect(
      en((c) =>
        updateCustomField(c, { tenantId: tenant, fieldId: lista.id, label: 'Local', options: [] }),
      ),
    ).rejects.toThrow(/opciones/);

    // Ni el campo ni el libro se movieron: el rechazo es antes del UPDATE y
    // además va dentro de la misma transacción.
    const quedo = (await en((c) => listCustomFields(c, tenant, 'contact'))).find(
      (f) => f.key === 'sucursal',
    )!;
    expect(quedo.label).toBe('Sucursal');
    expect(quedo.options).toEqual(['Centro', 'Mall']);
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1 AND resource_id = $2 AND action = 'fields.update'`,
      [tenant, lista.id],
    );
    expect(r.rows[0].n).toBe(0);
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
      type: 'texto',
      required: false,
      visibleIa: false,
      options: [],
    });
    // «Se borró el campo Convenio» no dice si se perdió el dato de una ficha
    // o de tres mil.
    expect(r.rows[0].metadata.fichasConValor).toBe(1);
  });

  it('la cuenta mira la tabla de ESA entidad: empresas y oportunidades', async () => {
    // Las tres entidades usan la misma llave a propósito. El contacto de más
    // arriba tiene `convenio` con valor, así que si el mapa entidad→tabla
    // apuntara a la tabla equivocada, estos dos números saldrían con el conteo
    // de contactos y no con el suyo. Es el único lugar donde corren las ramas
    // 'company' y 'deal' —el nombre de la tabla se interpola en el SQL, así
    // que un valor malo acá no es un número raro: es un error de Postgres—.
    await admin.query(
      `INSERT INTO companies (tenant_id, name, custom) VALUES
         ($1, 'Ferretería Lo Prado', '{"convenio": "Caja Los Andes"}'::jsonb),
         ($1, 'Panadería San Juan', '{"convenio": "Caja 18"}'::jsonb),
         ($1, 'Sin convenio', '{}'::jsonb)`,
      [tenant],
    );

    const deEmpresa = await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'company', label: 'Convenio', type: 'texto' }),
    );
    const deOportunidad = await en((c) =>
      createCustomField(c, { tenantId: tenant, entity: 'deal', label: 'Convenio', type: 'texto' }),
    );
    await en((c) => deleteCustomField(c, { tenantId: tenant, fieldId: deEmpresa.id }));
    await en((c) => deleteCustomField(c, { tenantId: tenant, fieldId: deOportunidad.id }));

    const r = await admin.query(
      `SELECT resource_id, metadata FROM audit_log
        WHERE tenant_id = $1 AND action = 'fields.delete' AND resource_id = ANY($2::text[])`,
      [tenant, [deEmpresa.id, deOportunidad.id]],
    );
    const por = Object.fromEntries(r.rows.map((f) => [f.resource_id, f.metadata]));
    expect(por[deEmpresa.id]).toMatchObject({ entity: 'company', fichasConValor: 2 });
    // Ninguna oportunidad en este negocio: cero, aunque haya un contacto y dos
    // empresas con `convenio` cargado.
    expect(por[deOportunidad.id]).toMatchObject({ entity: 'deal', fichasConValor: 0 });
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

  /**
   * Dos campos homónimos en la misma ficha, y por qué es grave.
   *
   * Lo que el asistente ve lo arma `paraLaIa` indexando por ETIQUETA, no por
   * llave. Con dos campos que se llaman igual, uno pisa al otro: el valor
   * real desaparece y el del otro campo sale bajo ese nombre. La reproducción
   * exacta —«Convenio» y «Nota interna», PATCH de la etiqueta del segundo— la
   * encontró la revisión del cambio que agregó la edición.
   *
   * No podía pasar antes de que existiera el PATCH: la llave se derivaba de
   * la etiqueta y el UNIQUE `(tenant_id, entity, key)` lo rechazaba. La
   * puerta nueva cambia la etiqueta sin tocar la llave.
   */
  it('la edición no deja dos campos de la misma ficha con el mismo nombre', async () => {
    // Tenant propio: las etiquetas chocan por (tenant, entidad), así que un
    // campo declarado por otra prueba de este archivo cambiaría el resultado.
    const t = (await admin.query("INSERT INTO tenants (name) VALUES ('homonimos') RETURNING id"))
      .rows[0].id as string;
    await withTenant(admin, t, async (c) => {
      await createCustomField(c, { tenantId: t, entity: 'contact', label: 'Convenio', type: 'texto' });
      const nota = await createCustomField(c, {
        tenantId: t, entity: 'contact', label: 'Nota interna', type: 'texto',
      });
      await expect(
        updateCustomField(c, { tenantId: t, fieldId: nota.id, label: 'Convenio' }),
      ).rejects.toThrow(/Ya hay otro campo que se llama/);
    });

    // Y el mismo nombre en OTRA ficha sí se puede: el choque es por entidad,
    // porque `paraLaIa` arma la ficha de una entidad por vez.
    await withTenant(admin, t, async (c) => {
      const deEmpresa = await createCustomField(c, {
        tenantId: t, entity: 'company', label: 'Rubro', type: 'texto',
      });
      await expect(
        updateCustomField(c, { tenantId: t, fieldId: deEmpresa.id, label: 'Convenio' }),
      ).resolves.toMatchObject({ label: 'Convenio' });
    });
  });
});
