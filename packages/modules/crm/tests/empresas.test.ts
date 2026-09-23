import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { createCustomField } from '../application/campos';
import {
  archiveCompany,
  asignarEmpresa,
  companyContacts,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from '../application/empresas';
import { getContactFicha } from '../application/activities';

/**
 * Empresas (issue 248). La tabla estaba desde 0001 con `contacts.company_id`
 * apuntándole, y no había forma de crear ninguna.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let ajeno: string;
let contacto: string;

const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('empresas-test') RETURNING id");
  tenant = t.rows[0].id;
  const o = await admin.query("INSERT INTO tenants (name) VALUES ('empresas-ajeno') RETURNING id");
  ajeno = o.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Paula', '+56955550001', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
});

afterAll(async () => {
  // No se limpia nada: `audit_log` es append-only por trigger y borrarlo
  // desde un test sería probar lo contrario de lo que queremos. La base de
  // los tests es de un solo uso.
  await admin.end();
});

describe('crear una empresa', () => {
  it('nace con nombre limpio y sin RUT si no se le da', async () => {
    const e = await en((c) => createCompany(c, { tenantId: tenant, name: '  Panadería   San   Juan ' }));
    expect(e.name).toBe('Panadería San Juan');
    expect(e.rut).toBeNull();
    expect(e.archivedAt).toBeNull();
  });

  it('el RUT se valida con dígito verificador y se guarda normalizado', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Ferretería Los Andes', rut: '76.086.428-5' }),
    );
    expect(e.rut).toBe('76086428-5');

    await expect(
      en((c) => createCompany(c, { tenantId: tenant, name: 'Con RUT malo', rut: '76086428-9' })),
    ).rejects.toThrow(/RUT inválido/);
  });

  it('dos fichas del mismo RUT es el mismo problema que dos contactos con el mismo teléfono', async () => {
    await expect(
      en((c) => createCompany(c, { tenantId: tenant, name: 'La misma de antes', rut: '76086428-5' })),
    ).rejects.toThrow(/Ya existe una empresa con ese RUT: "Ferretería Los Andes"/);
  });

  it('sin nombre no hay empresa', async () => {
    await expect(en((c) => createCompany(c, { tenantId: tenant, name: '   ' }))).rejects.toThrow(
      /necesita un nombre/,
    );
  });
});

describe('los campos personalizados de la empresa', () => {
  it('se validan al escribirla, igual que los del contacto', async () => {
    await en((c) =>
      createCustomField(c, {
        tenantId: tenant,
        entity: 'company',
        label: 'Giro',
        type: 'lista',
        options: ['retail', 'servicios'],
        required: true,
      }),
    );

    await expect(
      en((c) => createCompany(c, { tenantId: tenant, name: 'Sin giro' })),
    ).rejects.toThrow(/Falta "Giro", que es obligatorio/);

    await expect(
      en((c) => createCompany(c, { tenantId: tenant, name: 'Giro raro', custom: { giro: 'minería' } })),
    ).rejects.toThrow(/acepta: retail, servicios/);

    const ok = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Con giro', custom: { giro: 'retail' } }),
    );
    expect(ok.custom.giro).toBe('retail');
  });

  it('editar un campo no borra los demás', async () => {
    const e = await en((c) =>
      createCompany(c, {
        tenantId: tenant,
        name: 'Multi campo',
        custom: { giro: 'retail', interna: 'no declarada' },
      }),
    );
    const editada = await en((c) =>
      updateCompany(c, { tenantId: tenant, id: e.id, custom: { giro: 'servicios' } }),
    );
    expect(editada.custom.giro).toBe('servicios');
    expect(editada.custom.interna).toBe('no declarada');
  });
});

describe('colgar contactos', () => {
  let empresa: string;

  it('un contacto se cuelga y se descuelga', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Empresa con gente', custom: { giro: 'retail' } }),
    );
    empresa = e.id;

    await en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: empresa }));
    expect(await en((c) => companyContacts(c, tenant, empresa))).toHaveLength(1);

    await en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: null }));
    expect(await en((c) => companyContacts(c, tenant, empresa))).toHaveLength(0);
  });

  it('la ficha del contacto dice de qué empresa es (#460)', async () => {
    // `contacts.company_id` existía desde #217 y la ficha no lo
    // proyectaba: la pantalla no podía mostrarlo ni ofrecerse a cambiarlo,
    // así que Empresas mostraba fichas vacías para siempre.
    const e = await en((c) => createCompany(c, { tenantId: tenant, name: 'Ferretería Rosa', custom: { giro: 'retail' } }));
    await en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: e.id }));
    const ficha = await en((c) => getContactFicha(c, tenant, contacto));
    expect(ficha.contact.company_id).toBe(e.id);
    expect(ficha.contact.company_name).toBe('Ferretería Rosa');

    await en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: null }));
    const sinEmpresa = await en((c) => getContactFicha(c, tenant, contacto));
    expect(sinEmpresa.contact.company_id).toBeNull();
    expect(sinEmpresa.contact.company_name).toBeNull();
  });

  it('a un contacto que no existe no se le asigna nada', async () => {
    await expect(
      en((c) =>
        asignarEmpresa(c, {
          tenantId: tenant,
          contactId: '00000000-0000-0000-0000-000000000000',
          companyId: empresa,
        }),
      ),
    ).rejects.toThrow(/No encontramos ese contacto/);
  });
});

describe('archivar, que no es borrar', () => {
  it('la empresa sigue existiendo y los contactos quedan sueltos', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'La que se archiva', custom: { giro: 'retail' } }),
    );
    await en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: e.id }));

    const r = await en((c) => archiveCompany(c, { tenantId: tenant, id: e.id }));
    expect(r.contactosSueltos).toBe(1);
    expect(r.empresa.archivedAt).not.toBeNull();

    // La fila sigue ahí: nada se borra.
    const sigue = await en((c) => getCompany(c, tenant, e.id));
    expect(sigue.name).toBe('La que se archiva');

    // Pero ya no aparece en la lista ni se le pueden colgar contactos.
    const lista = await en((c) => listCompanies(c, tenant));
    expect(lista.find((x) => x.id === e.id)).toBeUndefined();
    expect((await en((c) => listCompanies(c, tenant, { incluirArchivadas: true }))).find((x) => x.id === e.id))
      .toBeDefined();

    await expect(
      en((c) => asignarEmpresa(c, { tenantId: tenant, contactId: contacto, companyId: e.id })),
    ).rejects.toThrow(/archivada/);
    await expect(en((c) => updateCompany(c, { tenantId: tenant, id: e.id, name: 'Otro' }))).rejects.toThrow(
      /archivada/,
    );
  });

  it('archivar dos veces no vuelve a soltar contactos', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Doble archivo', custom: { giro: 'retail' } }),
    );
    await en((c) => archiveCompany(c, { tenantId: tenant, id: e.id }));
    const otra = await en((c) => archiveCompany(c, { tenantId: tenant, id: e.id }));
    expect(otra.contactosSueltos).toBe(0);
  });

  it('el RUT de una archivada se puede volver a usar', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Cerrada', rut: '77.220.465-5', custom: { giro: 'retail' } }),
    );
    await en((c) => archiveCompany(c, { tenantId: tenant, id: e.id }));
    const nueva = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'La que la reemplaza', rut: '77220465-5', custom: { giro: 'retail' } }),
    );
    expect(nueva.rut).toBe('77220465-5');
  });
});

describe('aislamiento entre tenants', () => {
  it('el tenant de al lado no ve ni alcanza estas empresas', async () => {
    const mia = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Solo mía', custom: { giro: 'retail' } }),
    );
    const suyas = await withTenant(admin, ajeno, (c) => listCompanies(c, ajeno));
    expect(suyas).toHaveLength(0);
    await expect(withTenant(admin, ajeno, (c) => getCompany(c, ajeno, mia.id))).rejects.toThrow(
      /No encontramos esa empresa/,
    );
  });
});

describe('el rastro', () => {
  it('crear, editar y archivar quedan en audit_log', async () => {
    const e = await en((c) =>
      createCompany(c, { tenantId: tenant, name: 'Con rastro', custom: { giro: 'retail' }, actor: 'u1' }),
    );
    await en((c) => updateCompany(c, { tenantId: tenant, id: e.id, name: 'Con rastro S.A.', actor: 'u1' }));
    await en((c) => archiveCompany(c, { tenantId: tenant, id: e.id, actor: 'u1' }));

    const r = await admin.query(
      `SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY id`,
      [tenant, e.id],
    );
    expect(r.rows.map((x) => x.action)).toEqual([
      'companies.create',
      'companies.update',
      'companies.archive',
    ]);
  });
});
