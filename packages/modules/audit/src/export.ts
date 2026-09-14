import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Exportación del libro de auditoría (#72, SPEC §13). Un export que el
// auditor no puede verificar no sirve de nada: el documento viaja con el
// sha256 de su contenido y una firma HMAC del servidor. Si el servidor no
// tiene secreto, la firma sale `null` A LA VISTA — jamás se finge.

/** Columnas FIJAS y en este orden: un CSV que cambia de forma no se audita. */
export const COLUMNAS_EXPORT = [
  'id',
  'tenant_id',
  'occurred_at',
  'actor',
  'actor_kind',
  'action',
  'resource',
  'resource_id',
  'result',
  'ip',
  'request_id',
  'metadata',
] as const;

export type AuditExportRow = Record<string, unknown>;

export interface SignedExport {
  format: 'csv' | 'json';
  generatedAt: string;
  rows: number;
  sha256: string;
  /** null cuando el servidor no tiene AUDIT_EXPORT_SECRET configurado. */
  signature: string | null;
  payload: string;
}

function celda(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
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

export function auditToCsv(rows: AuditExportRow[]): string {
  const lineas = [COLUMNAS_EXPORT.join(',')];
  for (const row of rows) {
    lineas.push(COLUMNAS_EXPORT.map((c) => celda((row as Record<string, unknown>)[c])).join(','));
  }
  return lineas.join('\n');
}

export function auditToJson(rows: AuditExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Empaqueta y firma. `generatedAt` viene de fuera para que el documento sea
 * reproducible en un test y para no depender del reloj dentro de la firma.
 */
export function signExport(
  rows: AuditExportRow[],
  format: 'csv' | 'json',
  options: { secret?: string | null; generatedAt?: string } = {},
): SignedExport {
  const payload = format === 'csv' ? auditToCsv(rows) : auditToJson(rows);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const secret = options.secret ?? process.env.AUDIT_EXPORT_SECRET ?? null;
  return {
    format,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    rows: rows.length,
    sha256,
    signature: secret ? createHmac('sha256', secret).update(sha256).digest('hex') : null,
    payload,
  };
}

/**
 * La verificación de referencia: la misma que puede correr un auditor con el
 * secreto en la mano. Recalcula el hash del contenido y compara la firma en
 * tiempo constante.
 */
export function verifyExport(doc: SignedExport, secret: string): boolean {
  if (!doc?.payload || !doc.signature) return false;
  const sha256 = createHash('sha256').update(doc.payload).digest('hex');
  if (sha256 !== doc.sha256) return false;
  const esperada = createHmac('sha256', secret).update(sha256).digest('hex');
  const a = Buffer.from(esperada);
  const b = Buffer.from(doc.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
