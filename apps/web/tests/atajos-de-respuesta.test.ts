import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Atajos de respuesta (#460).
 *
 * `POST /quick-replies` y `DELETE /quick-replies/:id` existen desde #39 y
 * la única pantalla que los tocaba era el desplegable de la bandeja, que
 * solo los LEE. Para tener un atajo había que crearlo llamando a la API a
 * mano; para borrar uno con una falta de ortografía, lo mismo — y un atajo
 * mal escrito se manda muchas veces antes de que alguien se atreva a pedir
 * que lo arreglen.
 */
const ATAJOS = readFileSync(join(__dirname, '..', 'components', 'atajos-de-respuesta.tsx'), 'utf8');
const PAGINA = readFileSync(
  join(__dirname, '..', 'app', 'ajustes', 'bandeja', 'page.tsx'),
  'utf8',
);

describe('administrar los atajos', () => {
  it('vive en los ajustes de la bandeja', () => {
    expect(PAGINA).toContain('<AtajosDeRespuesta />');
  });

  it('se crean y se borran', () => {
    expect(ATAJOS).toContain("'/quick-replies'");
    expect(ATAJOS).toContain('`/quick-replies/${a.id}`');
    expect(ATAJOS).toContain("method: 'DELETE'");
  });

  it('distingue el mío del negocio', () => {
    // El servidor exige `quickreplies.manage` para los del negocio; acá se
    // elige cuál se está creando y se muestra de quién es cada uno.
    expect(ATAJOS).toContain("scope: 'mio'");
    expect(ATAJOS).toContain("a.userId ? 'Mío' : 'Del negocio'");
  });

  it('la lista muestra el texto YA reemplazado', () => {
    // Una variable mal escrita se nota acá y no en el teléfono de un
    // cliente.
    expect(ATAJOS).toContain('renderQuickReply(a.body');
  });

  it('el error del servidor se muestra tal cual', () => {
    // "Los atajos del negocio los administra quien supervisa el equipo" ya
    // está escrito allá; repetirlo acá sería que un día dejen de coincidir.
    expect(ATAJOS).toContain('setAviso((err as Error).message)');
  });
});
