import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import {
  contactTags,
  createTag,
  deleteTag,
  listTags,
  setContactTags,
  updateTag,
} from '../application/tags';

// Etiquetas (issue 248): la tabla existía, el tablero filtraba por ellas y
// no había forma de crear ninguna.

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';

let admin: Pool;
let tenant: string;
let ajeno: string;
let contacto: string;
const duena = randomUUID();

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  const t = await admin.query("INSERT INTO tenants (name) VALUES ('tags-test') RETURNING id");
  tenant = t.rows[0].id;
  const o = await admin.query("INSERT INTO tenants (name) VALUES ('tags-ajeno') RETURNING id");
  ajeno = o.rows[0].id;
  const c = await admin.query(
    `INSERT INTO contacts (tenant_id, name, phone, origin) VALUES ($1, 'Paula', '+56944440001', 'whatsapp') RETURNING id`,
    [tenant],
  );
  contacto = c.rows[0].id;
});

afterAll(async () => {
  await admin.end();
});

const en = <T>(t: string, fn: (c: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
  withTenant(admin, t, fn);

describe('etiquetas del negocio', () => {
  it('se crean con su color de rol, y el nombre repetido no duplica', async () => {
    const uno = await en(tenant, (c) => createTag(c, { tenantId: tenant, name: '  Moroso  ', role: 'bad' }));
    expect(uno.name).toBe('Moroso'); // se limpia el espacio
    expect(uno.role).toBe('bad');

    const otra = await en(tenant, (c) => createTag(c, { tenantId: tenant, name: 'Moroso' }));
    expect(otra.id).toBe(uno.id); // la misma, no una segunda
    expect((await en(tenant, (c) => listTags(c, tenant)))).toHaveLength(1);
  });

  it('el color sale de la paleta, y el nombre no puede ser vacío', async () => {
    await expect(
      en(tenant, (c) => createTag(c, { tenantId: tenant, name: 'X', role: 'fucsia' })),
    ).rejects.toThrow(/paleta/);
    await expect(en(tenant, (c) => createTag(c, { tenantId: tenant, name: '   ' }))).rejects.toThrow(
      /nombre/,
    );
  });

  it('se marcan y desmarcan en el contacto: se guarda lo que quedó', async () => {
    const frecuente = await en(tenant, (c) =>
      createTag(c, { tenantId: tenant, name: 'Frecuente', role: 'good' }),
    );
    const morosa = (await en(tenant, (c) => listTags(c, tenant))).find((t) => t.name === 'Moroso')!;

    await en(tenant, (c) =>
      setContactTags(c, { tenantId: tenant, contactId: contacto, tagIds: [frecuente.id, morosa.id], actor: duena }),
    );
    expect(await en(tenant, (c) => contactTags(c, tenant, contacto))).toHaveLength(2);

    // Se desmarca una: queda exactamente la otra.
    const quedan = await en(tenant, (c) =>
      setContactTags(c, { tenantId: tenant, contactId: contacto, tagIds: [frecuente.id], actor: duena }),
    );
    expect(quedan.map((t) => t.name)).toEqual(['Frecuente']);
  });

  it('una etiqueta de OTRO negocio no se puede pegar acá', async () => {
    const dePeru = await en(ajeno, (c) => createTag(c, { tenantId: ajeno, name: 'Ajena', role: 'info' }));
    await expect(
      en(tenant, (c) =>
        setContactTags(c, { tenantId: tenant, contactId: contacto, tagIds: [dePeru.id], actor: duena }),
      ),
    ).rejects.toThrow(/no existe en este negocio/);
  });

  it('renombrar y cambiar el color; borrar la quita de los contactos', async () => {
    const frecuente = (await en(tenant, (c) => listTags(c, tenant))).find((t) => t.name === 'Frecuente')!;
    const cambiada = await en(tenant, (c) =>
      updateTag(c, { tenantId: tenant, tagId: frecuente.id, name: 'Clienta frecuente', role: 'action' }),
    );
    expect(cambiada.name).toBe('Clienta frecuente');
    expect(cambiada.role).toBe('action');

    const res = await en(tenant, (c) => deleteTag(c, { tenantId: tenant, tagId: frecuente.id }));
    expect(res.contactosAfectados).toBe(1);
    expect(await en(tenant, (c) => contactTags(c, tenant, contacto))).toHaveLength(0);
  });
});
