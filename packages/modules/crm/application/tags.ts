import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';

/**
 * Etiquetas del negocio (SPEC §10 y §23, issue 248).
 *
 * La tabla existía desde el primer día, con su rol de color de la paleta
 * Pulso y su unicidad por nombre. Lo que no existía era una forma de crear
 * una: el tablero ya filtraba por etiquetas que nadie podía escribir, y en
 * la fusión de contactos se copiaban etiquetas que nunca habían nacido.
 *
 * El `role` no es decoración: dice qué SIGNIFICA la etiqueta —'bad' para un
 * cliente moroso, 'good' para uno frecuente— y por eso la paleta es cerrada.
 */
export const ROLES_DE_ETIQUETA = ['action', 'good', 'warn', 'bad', 'info', 'neutral'] as const;
export type RolDeEtiqueta = (typeof ROLES_DE_ETIQUETA)[number];

export interface Etiqueta {
  id: string;
  name: string;
  role: RolDeEtiqueta;
  createdAt: Date;
}

function aEtiqueta(row: Record<string, unknown>): Etiqueta {
  return {
    id: row.id as string,
    name: row.name as string,
    role: row.role as RolDeEtiqueta,
    createdAt: row.created_at as Date,
  };
}

function nombreLimpio(nombre: string): string {
  const limpio = (nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!limpio) throw new Error('La etiqueta necesita un nombre.');
  if (limpio.length > 40) throw new Error('El nombre de la etiqueta es muy largo (máximo 40).');
  return limpio;
}

function rolValido(role: string | undefined): RolDeEtiqueta {
  const r = (role ?? 'neutral') as RolDeEtiqueta;
  if (!ROLES_DE_ETIQUETA.includes(r)) {
    throw new Error(`Color de etiqueta desconocido: ${role}. Usa uno de la paleta.`);
  }
  return r;
}

export async function listTags(client: PoolClient, tenantId: string): Promise<Etiqueta[]> {
  const r = await client.query('SELECT * FROM tags WHERE tenant_id = $1 ORDER BY name', [tenantId]);
  return r.rows.map(aEtiqueta);
}

export async function createTag(
  client: PoolClient,
  input: { tenantId: string; name: string; role?: string },
): Promise<Etiqueta> {
  const name = nombreLimpio(input.name);
  const role = rolValido(input.role);
  // Dos personas etiquetando a la vez no pueden pelearse por el mismo
  // nombre: si ya existe, se devuelve la que hay.
  const r = await client.query(
    `INSERT INTO tags (tenant_id, name, role) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [input.tenantId, name, role],
  );
  // Crear una etiqueta no publica evento: no hay nada afuera esperándolo y
  // el catálogo de eventos se amplía cuando algo lo necesita, no por si
  // acaso. Asignarla a alguien SÍ avisa, con `contact.updated`.
  return aEtiqueta(r.rows[0]);
}

export async function updateTag(
  client: PoolClient,
  input: { tenantId: string; tagId: string; name?: string; role?: string },
): Promise<Etiqueta> {
  const campos: string[] = [];
  const valores: unknown[] = [input.tenantId, input.tagId];
  if (input.name !== undefined) {
    valores.push(nombreLimpio(input.name));
    campos.push(`name = $${valores.length}`);
  }
  if (input.role !== undefined) {
    valores.push(rolValido(input.role));
    campos.push(`role = $${valores.length}`);
  }
  if (campos.length === 0) throw new Error('No hay nada que cambiar en la etiqueta.');
  const r = await client.query(
    `UPDATE tags SET ${campos.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    valores,
  );
  if (r.rowCount === 0) throw new Error('Esa etiqueta no existe en este negocio.');
  return aEtiqueta(r.rows[0]);
}

/**
 * Borrar una etiqueta la quita de todos los contactos que la tenían. Es lo
 * que espera quien la borra, y dejar las asignaciones colgando obligaría a
 * limpiarlas a mano.
 */
export async function deleteTag(
  client: PoolClient,
  input: { tenantId: string; tagId: string },
): Promise<{ contactosAfectados: number }> {
  const quitadas = await client.query(
    'DELETE FROM contact_tags WHERE tenant_id = $1 AND tag_id = $2',
    [input.tenantId, input.tagId],
  );
  const r = await client.query('DELETE FROM tags WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.tagId,
  ]);
  if (r.rowCount === 0) throw new Error('Esa etiqueta no existe en este negocio.');
  return { contactosAfectados: quitadas.rowCount ?? 0 };
}

/** Las etiquetas de un contacto, tal como las muestra su ficha. */
export async function contactTags(
  client: PoolClient,
  tenantId: string,
  contactId: string,
): Promise<Etiqueta[]> {
  const r = await client.query(
    `SELECT t.* FROM tags t
       JOIN contact_tags ct ON ct.tag_id = t.id AND ct.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1 AND ct.contact_id = $2
      ORDER BY t.name`,
    [tenantId, contactId],
  );
  return r.rows.map(aEtiqueta);
}

/**
 * Deja al contacto EXACTAMENTE con estas etiquetas. Se pasa la lista
 * completa y no un "agregar/quitar" porque es como funciona la ficha: se
 * marcan y desmarcan, y se guarda lo que quedó.
 */
export async function setContactTags(
  client: PoolClient,
  input: { tenantId: string; contactId: string; tagIds: string[]; actor: string; requestId?: string },
): Promise<Etiqueta[]> {
  const existe = await client.query('SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2', [
    input.tenantId,
    input.contactId,
  ]);
  if (existe.rowCount === 0) throw new Error('No encontramos a esa persona en este negocio.');

  const ids = [...new Set(input.tagIds)];
  if (ids.length > 0) {
    // Una etiqueta de OTRO negocio no se puede pegar acá, aunque venga el id.
    const propias = await client.query(
      'SELECT id FROM tags WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [input.tenantId, ids],
    );
    if (propias.rowCount !== ids.length) {
      throw new Error('Alguna de esas etiquetas no existe en este negocio.');
    }
  }

  await client.query('DELETE FROM contact_tags WHERE tenant_id = $1 AND contact_id = $2', [
    input.tenantId,
    input.contactId,
  ]);
  if (ids.length > 0) {
    await client.query(
      `INSERT INTO contact_tags (tenant_id, contact_id, tag_id)
       SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [input.tenantId, input.contactId, ids],
    );
  }
  await publishEvent(client, {
    name: 'contact.updated',
    tenantId: input.tenantId,
    payload: { contactId: input.contactId, etiquetas: ids.length },
    actor: input.actor,
    requestId: input.requestId,
  });
  return contactTags(client, input.tenantId, input.contactId);
}
