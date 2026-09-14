import { createHash } from 'node:crypto';

// El troceo (#51): pedazos con solape para que el retrieval no corte una
// idea al medio. Simple y determinista — sin dependencias.

const MAX_CHUNK = 1200;
const OVERLAP = 150;

export function splitIntoChunks(texto: string): string[] {
  const limpio = texto.replace(/\r\n/g, '\n').trim();
  if (!limpio) return [];
  if (limpio.length <= MAX_CHUNK) return [limpio];

  // Primero por párrafos; los gigantes se parten por oraciones.
  const piezas = limpio
    .split(/\n{2,}/)
    .flatMap((p) => (p.length <= MAX_CHUNK ? [p] : p.split(/(?<=[.!?])\s+/)))
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let actual = '';
  for (const pieza of piezas) {
    if (actual && actual.length + pieza.length + 1 > MAX_CHUNK) {
      chunks.push(actual);
      actual = actual.slice(-OVERLAP) + '\n' + pieza; // solape
    } else {
      actual = actual ? `${actual}\n${pieza}` : pieza;
    }
  }
  if (actual) chunks.push(actual);
  return chunks;
}

/** HTML de una URL a texto plano, sin dependencias. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function normalizeQuery(q: string): string {
  return q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

export function hashQuery(q: string): string {
  return createHash('sha256').update(normalizeQuery(q)).digest('hex');
}

/** El vector como literal pgvector ('[0.1,0.2,…]'). */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}
