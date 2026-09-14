// Reglas transversales del negocio aplicadas en dominio (SPEC §8):
// teléfonos E.164, RUT con dígito verificador, opt-out automático.

/**
 * Normaliza a E.164. Acepta formatos chilenos comunes ("9 1234 5678",
 * "09-1234-5678", "+56 9 ...") y números ya internacionales. Rechaza lo que
 * no se pueda normalizar sin ambigüedad.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s\-().]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^56\d{9}$/.test(digits)) return `+${digits}`;
  if (/^09?\d{8}$/.test(digits)) return `+569${digits.slice(-8)}`;
  if (/^9\d{8}$/.test(digits)) return `+56${digits}`;
  throw new Error(
    `Teléfono inválido: "${raw}". Usa formato internacional (+569...) o un celular chileno.`,
  );
}

/** Valida RUT chileno con dígito verificador; devuelve normalizado NNNNNNNN-D. */
export function normalizeRut(raw: string): string {
  const clean = raw.replace(/[.\s]/g, '').replace('-', '').toUpperCase();
  if (!/^\d{7,8}[0-9K]$/.test(clean)) {
    throw new Error(`RUT inválido: "${raw}".`);
  }
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  let sum = 0;
  let factor = 2;
  for (const c of [...body].reverse()) {
    sum += Number(c) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const expected = 11 - (sum % 11);
  const dvCalc = expected === 11 ? '0' : expected === 10 ? 'K' : String(expected);
  if (dv !== dvCalc) {
    throw new Error(`RUT inválido: "${raw}" (dígito verificador no coincide).`);
  }
  return `${body}-${dv}`;
}

const OPT_OUT_PATTERNS = [
  /\bbasta\b/i,
  /\bstop\b/i,
  /\bno\s+me\s+escriban?\b/i,
  /\bno\s+me\s+contacten?\b/i,
  /\bno\s+quiero\s+(m[aá]s\s+)?mensajes\b/i,
  /\bdesuscribir(me)?\b/i,
  /\bunsubscribe\b/i,
];

/** "BASTA", "STOP" y equivalentes marcan opt-out automático (SPEC §8). */
export function isOptOutMessage(text: string): boolean {
  return OPT_OUT_PATTERNS.some((p) => p.test(text));
}
