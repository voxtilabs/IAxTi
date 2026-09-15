import type { PoolClient } from 'pg';
import { listCustomFields } from './campos';

/**
 * Exportación de contactos a CSV (issue 248; el permiso `crm.contacts.export`
 * estaba anotado como «no construida» en el catálogo).
 *
 * La contraparte de la importación (#34): quien importó su lista tiene que
 * poder llevársela. Y va en CSV y no en JSON porque quien la pide la va a
 * abrir en una planilla.
 *
 * Los campos personalizados DECLARADOS salen como columnas propias (#248):
 * exportar `custom` como un bloque de JSON en una celda sería devolverle al
 * negocio algo que no puede usar.
 */
const COLUMNAS_BASE = [
  'nombre',
  'telefono',
  'email',
  'rut',
  'origen',
  'etiquetas',
  'opt_in',
  'opt_out',
  'creado',
  'ultima_actividad',
] as const;

function celda(valor: unknown): string {
  if (valor === null || valor === undefined) return '""';
  const texto =
    valor instanceof Date
      ? valor.toISOString()
      : typeof valor === 'object'
        ? JSON.stringify(valor)
        : String(valor);
  // Comillas dobladas y todo entre comillas: un texto con coma, salto de
  // línea o comilla no puede correr las columnas.
  return `"${texto.replace(/"/g, '""')}"`;
}

export interface ExportacionContactos {
  csv: string;
  filas: number;
  columnas: string[];
}

export async function exportarContactos(
  client: PoolClient,
  input: { tenantId: string; tope?: number },
): Promise<ExportacionContactos> {
  const tope = Math.min(Math.max(1, input.tope ?? 20_000), 50_000);
  const campos = await listCustomFields(client, input.tenantId, 'contact').catch(() => []);

  const r = await client.query(
    `SELECT c.name, c.phone, c.email, c.rut, c.origin, c.opt_in_at, c.opted_out_at,
            c.created_at, c.last_activity_at, c.custom,
            COALESCE(
              (SELECT string_agg(t.name, ' | ' ORDER BY t.name)
                 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id),
              ''
            ) AS etiquetas
       FROM contacts c
      WHERE c.tenant_id = $1 AND c.merged_into IS NULL
      ORDER BY c.created_at
      LIMIT $2`,
    [input.tenantId, tope],
  );

  const columnas = [...COLUMNAS_BASE, ...campos.map((f) => f.label)];
  const lineas = [columnas.map((c) => celda(c)).join(',')];
  for (const fila of r.rows) {
    const custom = (fila.custom as Record<string, unknown>) ?? {};
    lineas.push(
      [
        celda(fila.name),
        celda(fila.phone),
        celda(fila.email),
        celda(fila.rut),
        celda(fila.origin),
        celda(fila.etiquetas),
        celda(fila.opt_in_at),
        celda(fila.opted_out_at),
        celda(fila.created_at),
        celda(fila.last_activity_at),
        ...campos.map((f) => celda(custom[f.key])),
      ].join(','),
    );
  }

  return { csv: lineas.join('\n'), filas: r.rows.length, columnas };
}
