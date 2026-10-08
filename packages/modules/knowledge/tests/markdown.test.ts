import { describe, expect, it } from 'vitest';
import { enlacesDe, fuenteDesdeMarkdown } from '../domain/markdown';

/**
 * Leer markdown como fuente de conocimiento (#714).
 *
 * Sale de «¿sería bueno ponerle obsidian?». Obsidian no encaja, pero sí encaja
 * escribir en markdown y traerlo — y hace falta ahora, porque desde #716 el
 * copiloto tiene herramientas de conocimiento y sin fuentes cargadas sigue
 * contestando de memoria.
 */
describe('el nombre de la fuente', () => {
  it('sale del title del frontmatter cuando está', () => {
    // Quien escribió un `title` lo escribió a propósito: gana sobre todo lo demás.
    const f = fuenteDesdeMarkdown({
      nombre: 'sin-titulo-3.md',
      contenido: '---\ntitle: Precios de despacho\ntags: [precios]\n---\n# Otro encabezado\nTexto.',
    });
    expect(f.nombre).toBe('Precios de despacho');
  });

  it('si no hay frontmatter, del primer encabezado', () => {
    const f = fuenteDesdeMarkdown({ nombre: 'notas.md', contenido: '# Política de cambios\nTexto.' });
    expect(f.nombre).toBe('Política de cambios');
  });

  it('y si no hay ninguno, del archivo, sin la extensión ni la carpeta', () => {
    const f = fuenteDesdeMarkdown({ nombre: 'vault/ventas/garantias.md', contenido: 'Texto suelto.' });
    expect(f.nombre).toBe('garantias');
  });

  it('un title vacío no gana: cae al siguiente', () => {
    const f = fuenteDesdeMarkdown({
      nombre: 'x.md',
      contenido: '---\ntitle:\n---\n# El de verdad\nTexto.',
    });
    expect(f.nombre).toBe('El de verdad');
  });
});

describe('el frontmatter no entra al índice', () => {
  it('se saca del contenido', () => {
    // `tags: [precios, 2026]` no es conocimiento del negocio: es metadata, y en
    // el índice compite con el texto de verdad cuando alguien pregunta un precio.
    const f = fuenteDesdeMarkdown({
      nombre: 'p.md',
      contenido: '---\ntitle: Precios\ntags: [precios, 2026]\nautor: Carla\n---\nEl despacho cuesta 3.000.',
    });
    expect(f.contenido).toBe('El despacho cuesta 3.000.');
    expect(f.contenido).not.toContain('tags');
    expect(f.contenido).not.toContain('Carla');
  });

  it('un --- que NO es frontmatter no se toca', () => {
    // Una línea divisoria a mitad del texto es markdown normal. Comerse desde
    // ahí dejaría la fuente sin la mitad del contenido y nadie lo notaría.
    const contenido = 'Primero.\n\n---\n\nSegundo.';
    expect(fuenteDesdeMarkdown({ nombre: 'x.md', contenido }).contenido).toBe(contenido);
  });

  it('con saltos de Windows también', () => {
    const f = fuenteDesdeMarkdown({
      nombre: 'x.md',
      contenido: '---\r\ntitle: Con CRLF\r\n---\r\nTexto.',
    });
    expect(f.nombre).toBe('Con CRLF');
    expect(f.contenido).toBe('Texto.');
  });
});

describe('los enlaces de Obsidian', () => {
  it('se extraen, y NO se borran del texto', () => {
    // Un enlace es una referencia a otra parte del conocimiento del negocio.
    // Quitarlo dejaría el texto diciendo menos de lo que decía.
    const f = fuenteDesdeMarkdown({
      nombre: 'x.md',
      contenido: 'Ver [[precios]] y también [[garantías]].',
    });
    expect(f.enlaces).toEqual(['precios', 'garantías']);
    expect(f.contenido).toContain('[[precios]]');
  });

  it('un alias apunta al destino, no al alias', () => {
    // `[[precios|lo que cobramos]]` apunta a «precios»: el alias es cómo se lee.
    expect(enlacesDe('Mira [[precios|lo que cobramos]].')).toEqual(['precios']);
  });

  it('una sección es parte del destino, no otro documento', () => {
    expect(enlacesDe('[[precios#despacho]] y [[precios#retiro]]')).toEqual(['precios']);
  });

  it('no se repiten', () => {
    expect(enlacesDe('[[precios]] ... [[precios]] ... [[precios|otra vez]]')).toEqual(['precios']);
  });

  it('sin enlaces, lista vacía y no undefined', () => {
    expect(fuenteDesdeMarkdown({ nombre: 'x.md', contenido: 'Sin enlaces.' }).enlaces).toEqual([]);
  });

  it('un corchete suelto no inventa un enlace', () => {
    expect(enlacesDe('Esto [no es] un enlace, y [[]] tampoco.')).toEqual([]);
  });
});
