// CSV chileno de verdad (#34): el Excel local exporta con ';' tan seguido
// como con ','. Parser propio y chico: comillas, saltos dentro de comillas,
// y olfateo del delimitador. Puro.

export function sniffDelimiter(text: string): ';' | ',' {
  const primera = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const comas = (primera.match(/,/g) ?? []).length;
  const puntoComas = (primera.match(/;/g) ?? []).length;
  return puntoComas > comas ? ';' : ',';
}

export function parseCsv(text: string, delimiter?: ';' | ','): string[][] {
  const delim = delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let campo = '';
  let enComillas = false;
  const limpio = text.replace(/^\uFEFF/, ''); // BOM de Excel

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') enComillas = true;
    else if (c === delim) {
      row.push(campo.trim());
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && limpio[i + 1] === '\n') i++;
      row.push(campo.trim());
      campo = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      campo += c;
    }
  }
  row.push(campo.trim());
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

/** Campos importables y cómo se rotulan en el mapeo. */
export const IMPORT_FIELDS = ['phone', 'name', 'email', 'rut'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Adivina el mapeo por los encabezados típicos de un Excel chileno. */
export function guessMapping(headers: string[]): Record<number, ImportField> {
  const mapping: Record<number, ImportField> = {};
  headers.forEach((h, i) => {
    const limpio = h.toLowerCase();
    if (/tel|fono|celular|móvil|movil|whats/.test(limpio)) mapping[i] = 'phone';
    else if (/nombre|name|cliente|contacto/.test(limpio)) mapping[i] = 'name';
    else if (/mail|correo/.test(limpio)) mapping[i] = 'email';
    else if (/rut/.test(limpio)) mapping[i] = 'rut';
  });
  return mapping;
}
