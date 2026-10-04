import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('cargar una conversación (#690)', () => {
  const codigo = sinComentarios(readFileSync(BANDEJA, 'utf8'));

  it('la sugerencia de IA NO está en el camino que se espera', () => {
    // El `await` de la carga solo puede cubrir el detalle y los mensajes. Si
    // `/suggestion` vuelve a entrar ahí, una llamada al proveedor —que hoy puede
    // tardar tres minutos— deja la bandeja en blanco otra vez.
    const esperados = /const loUrgente = Promise\.all\(\[([\s\S]*?)\]\)/.exec(codigo)?.[1] ?? '';
    expect(esperados, 'el bloque que se espera no se encontró: ¿se renombró?').not.toBe('');
    expect(esperados).toContain('/messages?limit=');
    expect(esperados).not.toContain('/suggestion');
    expect(esperados).not.toContain('/analisis');
  });

  it('las tres que pueden no llegar se piden sueltas', () => {
    // Ya traían `.catch(() => null)` desde antes: estaba aceptado que pueden no
    // llegar. Lo que no puede es que algo que puede no llegar bloquee.
    for (const ruta of ['/suggestion', '/analisis', '/attachments/limites']) {
      const linea = codigo.split('\n').find((l) => l.includes(ruta)) ?? '';
      expect(linea, `${ruta} tiene que pedirse fuera del camino bloqueante`).toMatch(/void pedir|pedir</);
    }
  });

  it('cada respuesta comprueba que la conversación siga abierta', () => {
    // Con las llamadas sueltas esto importa MÁS que antes: cuatro respuestas
    // pueden volver cuando ya se cambió de conversación, y pisar la nueva con los
    // datos de la vieja es peor que cargar lento.
    const guardas = codigo.match(/sigueAbierta\(\)/g) ?? [];
    expect(guardas.length, 'falta la guarda en alguna respuesta').toBeGreaterThanOrEqual(5);
  });

  it('ya no queda el Promise.all de seis que esperaba a todas', () => {
    expect(codigo).not.toMatch(/const \[d, m, n, sug, ana, lim\] = await Promise\.all/);
  });
});
