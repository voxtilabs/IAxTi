import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * La bandeja no espera a la IA para mostrar lo que ya tiene (#690).
 *
 * «El panel es muy lento», «tarda todo en cargar». Abrir una conversación hace seis
 * llamadas, salen en paralelo —bien— y la pantalla esperaba a la ÚLTIMA con un solo
 * `Promise.all`. Una de las seis es `/suggestion`, que llama al proveedor de IA: el
 * 28/09 NVIDIA se puso a encolar y esa petición pasó de 2 s a 170 s, medido con curl
 * pelado (139 s y 178 s).
 *
 * O sea, el mensaje del cliente —que ya estaba en la mano— no se mostraba hasta que
 * contestara el copiloto. Seis llamadas con un solo `await` convierten la más lenta
 * en el techo de todas.
 *
 * Esta prueba mira el código y no el navegador porque las pruebas del web corren sin
 * DOM; lo que fija es la FORMA del defecto, que es la que se reintroduce sola la
 * próxima vez que alguien agregue una llamada «y la mete en el Promise.all porque
 * ahí están las otras».
 */
const BANDEJA = join(__dirname, '..', 'components', 'bandeja', 'bandeja.tsx');


describe('cargar una conversación (#690)', () => {
  const codigo = fuenteLimpia(readFileSync(BANDEJA, 'utf8'));

  /**
   * #761 agrupó las seis llamadas, y esta prueba lo frenó — con razón. Lo que
   * cuida no es el NÚMERO de llamadas: es que la pantalla no espere a lo que
   * puede tardar. Las dos cosas se pueden tener, y así quedó: dos arranques, y
   * solo uno se espera.
   *
   * Una respuesta agrupada es PEOR que un `Promise.all` para esto: dentro de una
   * sola respuesta HTTP no hay forma de dibujar lo que ya llegó. Por eso el
   * arranque está partido en el servidor y no solo en el cliente.
   */
  it('lo que se espera es SOLO el arranque urgente', () => {
    const esperado = /const loUrgente = pedir<[^>]+>\(([\s\S]*?)\)\.then/.exec(codigo)?.[1] ?? '';
    expect(esperado, 'no se encontró el camino que se espera: ¿se renombró?').not.toBe('');
    expect(esperado).toContain('/arranque');
    // Y no la ficha, que es donde vive lo que puede tardar: el copiloto vivía en
    // este camino y el 28/09 pasó de 2 s a 170 s.
    expect(esperado).not.toContain('/arranque/ficha');
  });

  it('la ficha se pide SIN esperarla', () => {
    const linea = codigo.split('\n').find((l) => l.includes('/arranque/ficha')) ?? '';
    expect(linea, 'la ficha no puede bloquear el hilo').toMatch(/void pedir/);
  });

  it('cada respuesta comprueba que la conversación siga abierta', () => {
    // Dos respuestas pueden volver cuando ya se cambió de conversación, y pisar
    // la nueva con los datos de la vieja es peor que cargar lento.
    //
    // Se cuenta por BLOQUE `.then` y no por apariciones: un umbral numérico
    // («al menos cinco») envejece con cada llamada que entra o sale, y la vez que
    // alguien quite una va a bajar el número en vez de mirar la propiedad.
    // Se mira lo que sigue a cada `.then(`, no un bloque delimitado por
    // indentación: los dos manejadores están a profundidades distintas y una
    // expresión regular atada a los espacios se rompe con el primer
    // reformateo — y lo hace en silencio, dando por bueno lo que no miró.
    const cuerpo = codigo.slice(
      codigo.indexOf('const cargarConversacion'),
      codigo.indexOf('useEffect(() => void cargarLista()'),
    );
    expect(cuerpo, 'no se encontró `cargarConversacion`: ¿se renombró?').not.toBe('');
    const manejadores = cuerpo.split('.then(').slice(1);
    expect(manejadores.length, 'no se encontró ningún `.then` de carga').toBeGreaterThanOrEqual(2);
    for (const [i, trozo] of manejadores.entries()) {
      expect(
        trozo.slice(0, 400),
        `el manejador #${i + 1} no comprueba que la conversación siga abierta`,
      ).toContain('sigueAbierta()');
    }
  });

  it('no vuelve un solo `await` que espere a todas', () => {
    expect(codigo).not.toMatch(/const \[d, m, n, sug, ana, lim\] = await Promise\.all/);
    // Ni la versión con el arranque entero, que es la forma nueva del mismo
    // defecto: una sola llamada que trae todo y se espera.
    expect(codigo).not.toMatch(/await pedir<[^>]*>\(`\/conversations\/\$\{id\}\/arranque`\)/);
  });
});
