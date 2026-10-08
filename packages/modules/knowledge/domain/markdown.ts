/**
 * Leer un archivo markdown como fuente de conocimiento (#714).
 *
 * De dónde sale: «¿sería bueno ponerle obsidian? para ver su fuente de
 * conocimientos». Obsidian no encaja —es una app de escritorio sobre archivos
 * locales y de un solo usuario, y el conocimiento ya vive en Postgres con RLS
 * por tenant— pero sí encaja lo que uno quiere de él: **escribir en markdown,
 * donde sea, y traerlo**.
 *
 * Y hace falta ahora: desde #716 el copiloto tiene `knowledge.search` y
 * `knowledge.get_product` incluso en conversaciones sin dueño. Si no hay fuentes
 * cargadas, sigue contestando de memoria — ahora al menos lo dice (#717), pero
 * decirlo no es resolverlo.
 *
 * Esto es SOLO el parseo: nada de red, nada de base. Vive en `domain/` porque no
 * depende de infraestructura y porque así se puede probar con un archivo de
 * texto y nada más.
 */

export interface ArchivoMarkdown {
  /** El nombre del archivo, con o sin `.md`. */
  nombre: string;
  contenido: string;
}

export interface FuenteDesdeMarkdown {
  /** Cómo se va a llamar la fuente. */
  nombre: string;
  /** El texto a indexar, sin el frontmatter. */
  contenido: string;
  /**
   * Los `[[enlaces]]` que había, en orden y sin repetir.
   *
   * No se borran del contenido: un enlace es una referencia a otra parte del
   * conocimiento del negocio, y quitarla dejaría el texto diciendo menos de lo
   * que decía. Se extraen ADEMÁS, para poder registrarlos como relación.
   */
  enlaces: string[];
}

/**
 * El frontmatter de YAML que ponen Obsidian y casi todo lo demás.
 *
 * Se saca del contenido a indexar: `tags: [precios, 2026]` no es conocimiento
 * del negocio, es metadata, y metido en el índice compite con el texto de verdad
 * cuando alguien pregunta por un precio.
 *
 * Solo se lee `title`, y a propósito: adivinar más campos sería inventar un
 * contrato con el editor de cada uno.
 */
function separarFrontmatter(texto: string): { titulo: string | null; cuerpo: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(texto);
  if (!m) return { titulo: null, cuerpo: texto };
  const titulo = /^title:\s*(.+)$/m.exec(m[1])?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return { titulo: titulo || null, cuerpo: texto.slice(m[0].length) };
}

/** El primer `# título` del archivo, si lo hay. */
function primerEncabezado(cuerpo: string): string | null {
  return /^#\s+(.+)$/m.exec(cuerpo)?.[1]?.trim() || null;
}

/** El nombre del archivo sin la extensión ni la carpeta. */
function nombreDeArchivo(ruta: string): string {
  return (ruta.split('/').pop() ?? ruta).replace(/\.(md|markdown)$/i, '').trim();
}

/**
 * Los `[[enlaces]]` de Obsidian, incluidos los que llevan alias.
 *
 * `[[precios|lo que cobramos]]` apunta a «precios»: el alias es cómo se lee, no
 * a qué apunta. Y `[[precios#despacho]]` apunta a «precios» igual — la sección
 * es parte del destino, no otro documento.
 */
export function enlacesDe(texto: string): string[] {
  const vistos = new Set<string>();
  for (const m of texto.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const destino = m[1].split('|')[0].split('#')[0].trim();
    if (destino) vistos.add(destino);
  }
  return [...vistos];
}

/**
 * Lee un archivo y devuelve lo que haría falta para crear la fuente.
 *
 * El nombre sale, en orden: del `title` del frontmatter, del primer `#` del
 * texto, o del nombre del archivo. Ese orden no es arbitrario — es de lo más
 * explícito a lo más circunstancial: alguien que escribió un `title` lo escribió
 * a propósito, y un nombre de archivo puede ser «sin-titulo-3».
 */
export function fuenteDesdeMarkdown(archivo: ArchivoMarkdown): FuenteDesdeMarkdown {
  const { titulo, cuerpo } = separarFrontmatter(archivo.contenido);
  const contenido = cuerpo.trim();
  return {
    nombre: titulo ?? primerEncabezado(contenido) ?? nombreDeArchivo(archivo.nombre),
    contenido,
    enlaces: enlacesDe(contenido),
  };
}
