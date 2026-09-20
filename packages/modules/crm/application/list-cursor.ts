import { createHash } from 'node:crypto';

export class InvalidListQuery extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Column = { sql: string; type: 'text' | 'numeric' | 'timestamptz' };

/** Solo interpola columnas de la lista cerrada del módulo; los valores son parámetros. */
export function listCursor(options: {
  columns: Record<string, Column>; defaultSort: string; sort?: string; order?: string;
  cursor?: string; limit?: number; scope: unknown; idColumn: string; params: unknown[];
}) {
  const sort = options.sort ?? options.defaultSort;
  const order = options.order ?? 'desc';
  if (!Object.hasOwn(options.columns, sort) || !['asc', 'desc'].includes(order)) {
    throw new InvalidListQuery('Ese orden no está disponible. Elige una columna de la tabla.');
  }
  const limit = options.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidListQuery('El tamaño de página debe estar entre 1 y 100.');
  }
  const column = options.columns[sort];
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const comparison = order === 'asc' ? '>' : '<';
  const scope = createHash('sha256').update(JSON.stringify(options.scope)).digest('base64url');
  let where: string | undefined;
  if (options.cursor) {
    try {
      if (options.cursor.length > 4096) throw new Error();
      const decoded = Buffer.from(options.cursor, 'base64url').toString();
      // Conserva cursores anteriores para el orden predeterminado.
      let value: { v: string | null; id: string; s: string; d: string; scope: string };
      if (decoded.startsWith('{')) value = JSON.parse(decoded);
      else {
        const [v, id] = decoded.split('|');
        if (sort !== options.defaultSort || order !== 'desc') throw new Error();
        value = { v, id, s: sort, d: order, scope };
      }
      if (value.s !== sort || value.d !== order || value.scope !== scope || !uuid.test(value.id)) throw new Error();
      if (value.v !== null && typeof value.v !== 'string') throw new Error();
      if (value.v !== null && column.type === 'numeric' && !/^-?\d+(?:\.\d+)?$/.test(value.v)) throw new Error();
      if (value.v !== null && column.type === 'timestamptz' && !Number.isFinite(Date.parse(value.v))) throw new Error();
      options.params.push(value.id);
      const id = `$${options.params.length}::uuid`;
      if (value.v === null) where = `(${column.sql} IS NULL AND ${options.idColumn} ${comparison} ${id})`;
      else {
        options.params.push(value.v);
        const v = `$${options.params.length}::${column.type}`;
        where = `(${column.sql} ${comparison} ${v} OR (${column.sql} = ${v} AND ${options.idColumn} ${comparison} ${id}) OR ${column.sql} IS NULL)`;
      }
    } catch {
      throw new InvalidListQuery('Ese cursor no corresponde a esta búsqueda. Vuelve a la primera página.');
    }
  }
  return {
    limit, where, orderBy: `${column.sql} ${direction} NULLS LAST, ${options.idColumn} ${direction}`,
    // El texto de Postgres conserva microsegundos; Date.toISOString() los truncaría.
    selectValue: `${column.sql}::text AS _cursor_value`,
    encode: (row: Record<string, unknown>) => Buffer.from(JSON.stringify({
      v: row._cursor_value, id: row.id, s: sort, d: order, scope,
    })).toString('base64url'),
  };
}
