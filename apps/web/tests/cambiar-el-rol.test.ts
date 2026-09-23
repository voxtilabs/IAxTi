import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cambiarle el rol a alguien del equipo (#460).
 *
 * `POST /roles/assign` existe desde #73 y no la llamaba nadie: el rol con
 * el que alguien entró era el que tenía para siempre, y la única salida
 * era quitarle el acceso y volver a invitarlo — perdiendo de paso la
 * fecha desde la que está.
 */
const EQUIPO = readFileSync(join(__dirname, '..', 'components', 'equipo.tsx'), 'utf8');

describe('cambiar el rol', () => {
  it('se cambia desde la fila de la persona', () => {
    expect(EQUIPO).toContain("'/roles/assign'");
    expect(EQUIPO).toContain('userId: m.userId, roleId');
  });

  it('no manda nada si el rol es el que ya tenía', () => {
    expect(EQUIPO).toContain('rol.name === m.rol');
  });

  it('sin el catálogo de roles no se ofrece el selector', () => {
    // El respaldo trae los roles base por NOMBRE y assign pide el id:
    // un selector que no puede asignar nada es peor que ninguno.
    expect(EQUIPO).toContain('roles.some((r) => r.id)');
  });

  it('el aviso del enlace es solo de las invitaciones', () => {
    // Pegado siempre, decía una cosa falsa la mitad de las veces.
    expect(EQUIPO).toContain("ok.startsWith('Invitación')");
  });

  it('después de cambiarlo, la lista se vuelve a pedir', () => {
    // El rol se muestra desde `/equipo`: sin recargar, la fila seguiría
    // diciendo el rol viejo aunque el cambio ya esté hecho.
    const i = EQUIPO.indexOf("'/roles/assign'");
    expect(EQUIPO.slice(i, i + 600)).toContain('await cargar()');
  });
});
