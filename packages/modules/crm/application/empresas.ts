import type { PoolClient } from 'pg';
import { writeAudit } from '@iaxti/module-audit';
import { normalizeRut } from '../domain/validation';
import { listCustomFields, validarCustom } from './campos';

/**
 * Empresas (SPEC §10, issue 248).
 *
 * La tabla estaba desde 0001 y no la escribía nadie, pero el esquema ya se
 * había comprometido con ella en dos lugares: `contacts.company_id` es una
 * clave foránea a esta tabla, y el CHECK de `custom_fields.entity` acepta
 * 'company'. Borrarla habría sido una migración destructiva en dos frentes
 * para ahorrarse una pantalla. Se implementa.
 *
 * Una empresa no es un contacto: no tiene teléfono ni consentimiento ni
 * ventana de 24 h. No se le escribe. Es la ficha a la que se cuelgan las
 * personas con las que sí se habla.
 */
export interface Empresa {
  id: string;
  name: string;
  rut: string | null;
  custom: Record<string, unknown>;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function aEmpresa(row: Record<string, unknown>): Empresa {
  return {
    id: row.id as string,
    name: row.name as string,
    rut: (row.rut as string | null) ?? null,
    custom: (row.custom as Record<string, unknown>) ?? {},
    archivedAt: (row.archived_at as Date | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function nombreLimpio(nombre: string): string {
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) throw new Error('La empresa necesita un nombre.');
  if (limpio.length > 120) throw new Error('El nombre de la empresa es muy largo (máximo 120).');
  return limpio;
}

/**
 * El RUT es opcional, pero si viene tiene que ser un RUT: el dígito
 * verificador se valida acá y no en la interfaz, porque por la API entran
 * también las integraciones.
 */
function rutLimpio(rut: string | null | undefined): string | null {
  if (rut === undefined || rut === null || String(rut).trim() === '') return null;
  return normalizeRut(String(rut));
}

async function camposValidados(
  client: PoolClient,
  tenantId: string,
  custom: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const campos = await listCustomFields(client, tenantId, 'company');
  return validarCustom(campos, custom ?? {});
}

export async function listCompanies(
  client: PoolClient,
  tenantId: string,
  opts: { incluirArchivadas?: boolean; buscar?: string } = {},
): Promise<Empresa[]> {
  const donde: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (!opts.incluirArchivadas) donde.push('archived_at IS NULL');
  if (opts.buscar?.trim()) {
    params.push(`%${opts.buscar.trim()}%`);
    donde.push(`(name ILIKE $${params.length} OR rut ILIKE $${params.length})`);
  }
  const r = await client.query(
    `SELECT * FROM companies WHERE ${donde.join(' AND ')} ORDER BY name LIMIT 200`,
    params,
  );
  return r.rows.map(aEmpresa);
}

export async function getCompany(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Empresa> {
  const r = await client.query('SELECT * FROM companies WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    id,
  ]);
  if (r.rowCount === 0) throw new Error('No encontramos esa empresa.');
  return aEmpresa(r.rows[0]);
}

export async function createCompany(
  client: PoolClient,
  input: {
    tenantId: string;
    name: string;
    rut?: string | null;
    custom?: Record<string, unknown>;
    actor?: string;
    requestId?: string;
  },
): Promise<Empresa> {
  const name = nombreLimpio(input.name);
  const rut = rutLimpio(input.rut);
  const custom = await camposValidados(client, input.tenantId, input.custom);

  if (rut) {
    // El índice único ya lo impediría, pero el mensaje de Postgres no sirve
    // para mostrárselo a nadie: dice cuál es la empresa que ya existe.
    const ya = await client.query(
      'SELECT id, name FROM companies WHERE tenant_id = $1 AND rut = $2 AND archived_at IS NULL',
      [input.tenantId, rut],
    );
    if (ya.rowCount) {
      throw new Error(`Ya existe una empresa con ese RUT: "${ya.rows[0].name}".`);
    }
  }

  const r = await client.query(
    `INSERT INTO companies (tenant_id, name, rut, custom) VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
    [input.tenantId, name, rut, JSON.stringify(custom)],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'companies.create',
    resource: 'company',
    resourceId: r.rows[0].id as string,
    result: 'ok',
    requestId: input.requestId,
    metadata: { name, rut },
  });
  return aEmpresa(r.rows[0]);
}

export async function updateCompany(
  client: PoolClient,
  input: {
    tenantId: string;
    id: string;
    name?: string;
    rut?: string | null;
    custom?: Record<string, unknown>;
    actor?: string;
    requestId?: string;
  },
): Promise<Empresa> {
  const actual = await getCompany(client, input.tenantId, input.id);
  if (actual.archivedAt) throw new Error('Esa empresa está archivada: recupérala antes de editarla.');

  const name = input.name === undefined ? actual.name : nombreLimpio(input.name);
  const rut = input.rut === undefined ? actual.rut : rutLimpio(input.rut);
  // Los campos personalizados se mezclan, no se reemplazan: un PATCH que
  // manda un solo campo no puede borrar los otros diez.
  const custom =
    input.custom === undefined
      ? actual.custom
      : await camposValidados(client, input.tenantId, { ...actual.custom, ...input.custom });

  if (rut && rut !== actual.rut) {
    const ya = await client.query(
      'SELECT name FROM companies WHERE tenant_id = $1 AND rut = $2 AND id <> $3 AND archived_at IS NULL',
      [input.tenantId, rut, input.id],
    );
    if (ya.rowCount) throw new Error(`Ya existe una empresa con ese RUT: "${ya.rows[0].name}".`);
  }

  const r = await client.query(
    `UPDATE companies SET name = $3, rut = $4, custom = $5::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.id, name, rut, JSON.stringify(custom)],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'companies.update',
    resource: 'company',
    resourceId: input.id,
    result: 'ok',
    requestId: input.requestId,
    metadata: { antes: { name: actual.name, rut: actual.rut }, despues: { name, rut } },
  });
  return aEmpresa(r.rows[0]);
}

/**
 * Archivar, no borrar. Los contactos que la tenían asignada quedan sueltos:
 * dejarlos apuntando a una empresa archivada haría que su ficha mostrara una
 * empresa que ya no está en ninguna lista, y nadie entendería por qué.
 */
export async function archiveCompany(
  client: PoolClient,
  input: { tenantId: string; id: string; actor?: string; requestId?: string },
): Promise<{ empresa: Empresa; contactosSueltos: number }> {
  const actual = await getCompany(client, input.tenantId, input.id);
  if (actual.archivedAt) return { empresa: actual, contactosSueltos: 0 };

  const sueltos = await client.query(
    'UPDATE contacts SET company_id = NULL, updated_at = now() WHERE tenant_id = $1 AND company_id = $2',
    [input.tenantId, input.id],
  );
  const r = await client.query(
    `UPDATE companies SET archived_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    [input.tenantId, input.id],
  );
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'companies.archive',
    resource: 'company',
    resourceId: input.id,
    result: 'ok',
    requestId: input.requestId,
    metadata: { name: actual.name, contactosSueltos: sueltos.rowCount ?? 0 },
  });
  return { empresa: aEmpresa(r.rows[0]), contactosSueltos: sueltos.rowCount ?? 0 };
}

/** Colgar un contacto de una empresa, o descolgarlo con `companyId: null`. */
export async function asignarEmpresa(
  client: PoolClient,
  input: {
    tenantId: string;
    contactId: string;
    companyId: string | null;
    actor?: string;
    requestId?: string;
  },
): Promise<{ contactId: string; companyId: string | null }> {
  if (input.companyId) {
    const empresa = await getCompany(client, input.tenantId, input.companyId);
    if (empresa.archivedAt) throw new Error('Esa empresa está archivada: no se le pueden colgar contactos.');
  }
  const r = await client.query(
    `UPDATE contacts SET company_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [input.tenantId, input.contactId, input.companyId],
  );
  if (r.rowCount === 0) throw new Error('No encontramos ese contacto.');
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'companies.assign',
    resource: 'contact',
    resourceId: input.contactId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { companyId: input.companyId },
  });
  return { contactId: input.contactId, companyId: input.companyId };
}

/** Los contactos colgados de una empresa, para su ficha. */
export async function companyContacts(
  client: PoolClient,
  tenantId: string,
  companyId: string,
): Promise<Array<{ id: string; name: string | null; phone: string }>> {
  const r = await client.query(
    `SELECT id, name, phone FROM contacts
      WHERE tenant_id = $1 AND company_id = $2 AND merged_into IS NULL
      ORDER BY name NULLS LAST, phone LIMIT 200`,
    [tenantId, companyId],
  );
  return r.rows.map((x) => ({
    id: x.id as string,
    name: (x.name as string | null) ?? null,
    phone: x.phone as string,
  }));
}
