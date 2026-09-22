import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Llevarse los datos del negocio (#447, #222).
 *
 * La exportación la exigen tres cosas distintas: la cancelación en un clic
 * (SPEC §6) la pide ANTES de cerrar, el borrado a los 90 días la ofrece
 * antes de eliminar, y la Ley 21.719 la pide como portabilidad. Las tres
 * suponen que el dueño puede apretar un botón — y la ruta existía desde
 * #222 sin que ningún frontend la llamara.
 */
const PANEL = readFileSync(join(__dirname, '..', 'components', 'llevarse-los-datos.tsx'), 'utf8');
const FACTURACION = readFileSync(join(__dirname, '..', 'components', 'facturacion.tsx'), 'utf8');

describe('la exportación del negocio', () => {
  it('está donde el dueño mira lo que paga', () => {
    // El momento en que alguien quiere llevarse sus datos es el mismo en
    // que está mirando su plan.
    expect(FACTURACION).toContain('LlevarseLosDatos');
  });

  it('se descarga como archivo', () => {
    expect(PANEL).toContain('createObjectURL');
    expect(PANEL).toMatch(/download\s*=/);
  });

  it('dice en voz alta si quedó INCOMPLETA', () => {
    // El resumen contaría lo que salió y nadie notaría lo que faltó.
    expect(PANEL).toMatch(/truncadas\.length > 0/);
    expect(PANEL).toContain('incompleta');
  });

  it('dice qué NO incluye y por qué', () => {
    // Sin esto, quien revisa cree que el archivo lo trae todo.
    expect(PANEL).toMatch(/ultima\.fuera/);
  });

  it('no promete que es solo para irse', () => {
    // Ofrecerla únicamente al cancelar la convierte en un trámite de
    // salida; es portabilidad, y se puede usar cuando uno quiera.
    expect(PANEL).toContain('no solo si te vas');
  });
});
