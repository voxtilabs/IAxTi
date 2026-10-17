/** Minimización antes de stdout y OTLP. No es un detector universal de PII. */
export function textoDeLog(texto: string): string {
  return texto
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [REDACTADO]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTADO]@')
    .replace(/([?&][\w.%~-]+=)[^&#\s"'<>]*/g, '$1[REDACTADO]')
    .replace(/((?:password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTADO]$2')
    .replace(/((?:password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"';}&]+/gi, '$1[REDACTADO]')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi, '[EMAIL]')
    .replace(/\+\d[\d ()-]{7,}\d/g, '[TELEFONO]')
    .slice(0, 8192);
}

// Los cuerpos se omiten enteros: buscar emails no basta para proteger una
// conversación o un prompt serializado dentro de config.data (p. ej. Axios).
const sensible = /password|passwd|token|secret|authorization|cookie|api.?key|email|phone|telefono|rut|credentials|^(body|content|messages|prompt|data|payload|request|headers|input|output|requestBody|responseBody)$/i;

export function argumentoDeLog(valor: unknown): string {
  if (typeof valor === 'string') return textoDeLog(valor);
  if (valor instanceof Error) return textoDeLog(valor.message);
  const vistos = new WeakSet<object>();
  const limpiar = (v: unknown, profundidad: number): unknown => {
    if (typeof v === 'string') return textoDeLog(v);
    if (typeof v === 'function') return '[FUNCION]';
    if (typeof v === 'bigint') return String(v);
    if (v === null || typeof v !== 'object') return v;
    if (vistos.has(v)) return '[CIRCULAR]';
    if (profundidad >= 5) return '[LIMITE]';
    vistos.add(v);
    if (v instanceof Error) return { name: v.name, message: textoDeLog(v.message), stack: textoDeLog(v.stack || '') };
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => limpiar(x, profundidad + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, sensible.test(k) ? '[REDACTADO]' : limpiar(x, profundidad + 1)]));
  };
  try { return textoDeLog(JSON.stringify(limpiar(valor, 0)) || String(valor)); }
  catch { return '[NO SERIALIZABLE]'; }
}
