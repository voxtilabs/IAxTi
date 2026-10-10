import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * De qué empresa es un contacto (#460).
 *
 * `PUT /contacts/:id/empresa` existe desde #217 y no la llamaba nadie: las
 * empresas se creaban y ningún contacto se podía colgar de una, así que la
 * pantalla de Empresas mostraba fichas vacías para siempre.
 */
const FICHA = readFileSync(
  join(__dirname, '..', 'components', 'crm', 'ficha-contacto.tsx'),
  'utf8',
);

describe('empresa del contacto', () => {
  it('se cambia desde la ficha', () => {
    expect(FICHA).toContain('`/contacts/${contactId}/empresa`');
    expect(FICHA).toContain("method: 'PUT'");
  });

  it('«Sin empresa» manda null, no un centinela', () => {
    // El servidor distingue: `null` lo descuelga, cualquier otra cosa
    // tendría que ser un id.
    expect(FICHA).toContain('valor === SIN_EMPRESA ? null : valor');
  });

  it('la empresa que tiene puesta aparece aunque no esté en la lista', () => {
    // Si estuviera archivada, el selector la mostraría como «Sin empresa»
    // y el primer cambio la borraría sin que nadie lo pidiera.
    expect(FICHA).toContain('!empresas.some((e) => e.id === contact.company_id)');
  });

  it('si no se pueden leer las empresas, la ficha se dibuja igual', () => {
    // El módulo puede estar apagado o el permiso faltar: eso no puede dejar en
    // blanco la ficha entera. Desde #761 el dato viene del arranque, y
    // `usePieza` deja `dato: undefined` en los tres casos que el `catch` de
    // antes cubría (sin-permiso, modulo-apagado, falla): el `?? []` es lo que
    // conserva la propiedad.
    expect(FICHA).toMatch(/usePieza\('empresas'\)/);
    // `[\s\S]{0,160}` y no `[^)]*`: el valor lleva un cast con sus propios
    // paréntesis, y una clase negada no los cruza.
    expect(FICHA).toMatch(/setEmpresas\([\s\S]{0,160}\?\? \[\]\)/);
  });
});
