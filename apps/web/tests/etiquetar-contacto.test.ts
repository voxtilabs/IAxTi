import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Etiquetar a alguien desde su ficha (#480).
 *
 * `PUT /tags/contacto/:contactId` existe desde #35 y no la llamaba nadie:
 * las etiquetas se creaban, se veían en la bandeja y en la ficha, y no
 * había dónde ponérselas a un contacto. El guard no lo veía porque el
 * `GET` de la misma ruta sí tenía consumidor.
 */
const FICHA = readFileSync(join(__dirname, '..', 'components', 'crm', 'ficha-contacto.tsx'), 'utf8');

describe('etiquetar un contacto', () => {
  it('se etiqueta desde la ficha', () => {
    expect(FICHA).toContain('`/tags/contacto/${contactId}`');
    expect(FICHA).toContain("method: 'PUT'");
  });

  it('manda la lista COMPLETA, que es lo que la ruta espera', () => {
    // Deja al contacto con exactamente esas: mandar solo la nueva le
    // borraría las demás.
    expect(FICHA).toContain('[...etiquetas.map((x) => x.id), t.id]');
    expect(FICHA).toContain('etiquetas.filter((x) => x.id !== t.id).map((x) => x.id)');
  });

  it('el menú no se cierra al marcar', () => {
    // Poner tres etiquetas son tres viajes; cerrar el menú en cada una
    // obliga a volver a abrirlo.
    expect(FICHA).toContain('e.preventDefault()');
  });

  it('si el catálogo no se puede leer, las puestas se siguen viendo', () => {
    /**
     * La propiedad no cambió; de dónde sale el catálogo, sí (#761).
     *
     * Antes se pedía a `/tags` con su propio `try/catch` que dejaba
     * `setCatalogo([])`. Ahora viene del arranque del shell, y `usePieza`
     * devuelve `dato: undefined` cuando la pieza es `sin-permiso`,
     * `modulo-apagado` o `falla` — los tres casos que ese `catch` cubría. El
     * `?? []` es lo que mantiene la propiedad: sin catálogo, las etiquetas que
     * el contacto ya tiene se siguen viendo y el selector queda sin opciones.
     */
    expect(FICHA).toMatch(/usePieza\('etiquetas'\)/);
    // `[\s\S]{0,160}` y no `[^)]*`: el valor lleva un cast con sus propios
    // paréntesis, y una clase negada no los cruza.
    expect(FICHA).toMatch(/setCatalogo\([\s\S]{0,160}\?\? \[\]\)/);
  });
});
