import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { writeAudit } from '@iaxti/module-audit';
import { normalizePhone, normalizeRut } from '../domain/validation';
import { guessMapping, parseCsv, type ImportField } from '../domain/csv';
import { createContact } from './contacts';

// Fusión e importación (#34, SPEC §10).

/**
 * Fusiona el duplicado EN el principal: conserva ambas historias y todos
 * los identificadores. El duplicado queda apuntando al principal
 * (merged_into) — no se borra ni se deshace automáticamente. Las tablas de
 * otros módulos (conversaciones) se re-apuntan consumiendo contact.merged.
 */
export async function mergeContacts(
  client: PoolClient,
  input: {
    tenantId: string;
    primaryId: string;
    duplicateId: string;
    actor?: string;
    requestId?: string;
  },
): Promise<void> {
  if (input.primaryId === input.duplicateId) {
    throw new Error('Elige dos contactos distintos para fusionar.');
  }
  const r = await client.query(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE',
    [input.tenantId, [input.primaryId, input.duplicateId]],
  );
  const principal = r.rows.find((row) => row.id === input.primaryId);
  const duplicado = r.rows.find((row) => row.id === input.duplicateId);
  if (!principal || !duplicado) throw new Error('No encontramos ese contacto. Puede que se haya eliminado.');
  if (principal.merged_into || duplicado.merged_into) {
    throw new Error('Uno de los dos ya fue fusionado antes.');
  }

  // El principal absorbe lo que le falta y GUARDA el identificador del otro.
  await client.query(
    `UPDATE contacts SET
       name = COALESCE(name, $3),
       email = COALESCE(email, $4),
       rut = COALESCE(rut, $5),
       opt_in_at = COALESCE(opt_in_at, $6),
       channels = channels || $7::jsonb,
       custom = $8::jsonb || custom,
       updated_at = now(), last_activity_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [
      input.tenantId,
      input.primaryId,
      duplicado.name,
      duplicado.email,
      duplicado.rut,
      duplicado.opt_in_at,
      JSON.stringify([{ type: 'phone', value: duplicado.phone, mergedFrom: input.duplicateId }]),
      JSON.stringify(duplicado.custom ?? {}),
    ],
  );

  // Lo del propio módulo se re-apunta aquí; conversaciones, por el evento.
  await client.query('UPDATE deals SET contact_id = $3 WHERE tenant_id = $1 AND contact_id = $2', [
    input.tenantId, input.duplicateId, input.primaryId,
  ]);
  await client.query('UPDATE activities SET contact_id = $3 WHERE tenant_id = $1 AND contact_id = $2', [
    input.tenantId, input.duplicateId, input.primaryId,
  ]);
  await client.query(
    `INSERT INTO contact_tags (tenant_id, contact_id, tag_id)
     SELECT tenant_id, $3, tag_id FROM contact_tags WHERE tenant_id = $1 AND contact_id = $2
     ON CONFLICT DO NOTHING`,
    [input.tenantId, input.duplicateId, input.primaryId],
  );

  await client.query(
    `UPDATE contacts SET merged_into = $3, merged_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.duplicateId, input.primaryId],
  );

  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'contacts.merge',
    resource: 'contact',
    resourceId: input.primaryId,
    result: 'ok',
    requestId: input.requestId,
    metadata: { primaryId: input.primaryId, duplicateId: input.duplicateId, duplicatePhone: duplicado.phone },
  });
  await publishEvent(client, {
    name: 'contact.merged',
    tenantId: input.tenantId,
    payload: { primaryId: input.primaryId, duplicateId: input.duplicateId },
    actor: input.actor,
    requestId: input.requestId,
  });
}

// --- Importación CSV (#34) ---

export interface ImportRowResult {
  fila: number; // 1-based, sin contar el encabezado
  ok: boolean;
  data?: { phone: string; name?: string; email?: string; rut?: string };
  /** Formato único de la API: {field, message} por error (fila por fila). */
  errores: Array<{ field: string; message: string }>;
  duplicadoEnArchivo: boolean;
  yaExiste: boolean;
}

export interface ImportPreview {
  headers: string[];
  mapping: Record<number, ImportField>;
  rows: ImportRowResult[];
  validas: number;
}

/**
 * Vista previa: parsea, mapea (o adivina el mapeo por encabezados), valida
 * teléfono E.164 y RUT fila por fila, y marca duplicados del archivo y
 * contra la base. NADA se escribe aquí.
 */
export async function previewImport(
  client: PoolClient,
  input: { tenantId: string; csv: string; mapping?: Record<number, ImportField> },
): Promise<ImportPreview> {
  const parsed = parseCsv(input.csv);
  if (parsed.length < 2) {
    throw new Error('El archivo necesita un encabezado y al menos una fila.');
  }
  const [headers, ...body] = parsed;
  const mapping = input.mapping ?? guessMapping(headers);
  if (!Object.values(mapping).includes('phone')) {
    throw new Error('Indica cuál columna es el teléfono: sin él no hay contacto.');
  }

  const vistos = new Set<string>();
  const rows: ImportRowResult[] = body.map((cols, i) => {
    const errores: Array<{ field: string; message: string }> = [];
    const data: ImportRowResult['data'] = { phone: '' };
    for (const [col, field] of Object.entries(mapping)) {
      const valor = cols[Number(col)]?.trim() ?? '';
      if (!valor) continue;
      try {
        if (field === 'phone') data.phone = normalizePhone(valor);
        else if (field === 'rut') data.rut = normalizeRut(valor);
        else data[field] = valor;
      } catch (err) {
        errores.push({ field, message: (err as Error).message });
      }
    }
    if (!data.phone && !errores.some((e) => e.field === 'phone')) {
      errores.push({ field: 'phone', message: 'Falta el teléfono en esta fila.' });
    }
    const duplicadoEnArchivo = Boolean(data.phone) && vistos.has(data.phone);
    if (data.phone) vistos.add(data.phone);
    return {
      fila: i + 1,
      ok: errores.length === 0 && !duplicadoEnArchivo,
      data: errores.length === 0 ? data : undefined,
      errores,
      duplicadoEnArchivo,
      yaExiste: false,
    };
  });

  const phones = rows.filter((r) => r.data?.phone).map((r) => r.data!.phone);
  if (phones.length > 0) {
    const existentes = await client.query(
      'SELECT phone FROM contacts WHERE tenant_id = $1 AND phone = ANY($2::text[])',
      [input.tenantId, phones],
    );
    const set = new Set(existentes.rows.map((r) => r.phone));
    for (const row of rows) {
      if (row.data?.phone && set.has(row.data.phone)) row.yaExiste = true;
    }
  }

  return { headers, mapping, rows, validas: rows.filter((r) => r.ok && !r.yaExiste).length };
}

/**
 * Confirmación: crea SOLO las filas válidas y nuevas. Los importados nacen
 * SIN opt-in (origin importado, SPEC §8/§10). Una entrada de audit por
 * corrida con las métricas.
 */
export async function confirmImport(
  client: PoolClient,
  input: { tenantId: string; csv: string; mapping?: Record<number, ImportField>; actor?: string; requestId?: string },
): Promise<{ created: number; skipped: number }> {
  const preview = await previewImport(client, input);
  let created = 0;
  let skipped = 0;
  for (const row of preview.rows) {
    if (!row.ok || row.yaExiste || !row.data) {
      skipped++;
      continue;
    }
    await createContact(client, {
      tenantId: input.tenantId,
      phone: row.data.phone,
      name: row.data.name,
      email: row.data.email,
      rut: row.data.rut,
      origin: 'importado',
      actor: input.actor,
      requestId: input.requestId,
    });
    created++;
  }
  await writeAudit(client, {
    tenantId: input.tenantId,
    actor: input.actor ?? 'system',
    actorKind: 'user',
    action: 'contacts.import.run',
    resource: 'contact',
    result: 'ok',
    requestId: input.requestId,
    metadata: { created, skipped, total: preview.rows.length },
  });
  return { created, skipped };
}
