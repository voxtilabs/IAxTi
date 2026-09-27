import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * La bandeja tiene que decir POR QUÉ no llegó (#645).
 *
 * El motivo se calcula con `causaLegible` —que convierte el código de Meta en
 * una frase en castellano—, se guarda en `messages.meta.error`, y durante meses
 * no se mostró: `rowToMessage` no lo proyectaba y la bandeja dibujaba «No
 * llegó» con un botón de reintentar. Once veces seguidas, con la explicación
 * escrita en la base esperando a que alguien la leyera.
 *
 * Esta guarda es de código fuente, como el resto de las del front (#564). No
 * prueba que se vea bonito; prueba que el motivo no se pueda volver a caer del
 * camino sin que nadie se dé cuenta.
 */
const CHAT = readFileSync(join(__dirname, '../components/bandeja/chat.tsx'), 'utf8');

/** Sin comentarios: los míos ya me han hecho pasar por verde cuatro veces. */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CODIGO = sinComentarios(CHAT);

describe('un mensaje que no llegó dice por qué (#645)', () => {
  it('la bandeja lee el motivo del mensaje, no solo su estado', () => {
    expect(
      /m\.error/.test(CODIGO),
      'La bandeja no lee `m.error`. El motivo vuelve a quedarse en la base y en ' +
        'pantalla dice solo «No llegó», que es lo que costó tres días.',
    ).toBe(true);
  });

  it('no ofrece reintentar cuando reintentar no puede servir', () => {
    // Con la ventana cerrada, reintentar un mensaje libre falla SIEMPRE. Un
    // botón que garantiza fallar invita a gastar el intento otra vez.
    const bloque = CODIGO.slice(
      CODIGO.indexOf("deliveryStatus === 'failed'"),
      CODIGO.indexOf("deliveryStatus === 'failed'") + 1200,
    );
    expect(bloque).toContain('onReintentar');
    expect(
      /enVentana\s*\?/.test(bloque),
      'El botón de reintentar no mira la ventana: se ofrece también cuando no ' +
        'puede funcionar.',
    ).toBe(true);
  });

  it('el estado de la ventana sigue saliendo de la API y no de una cuenta propia', () => {
    // Es lo que se arregló en #639: la bandeja calculaba las 24 h por su lado y
    // sin mirar el canal. Si vuelve a aparecer una resta de fechas acá, las dos
    // reglas se separan otra vez.
    expect(CODIGO).toContain('ventanaAbierta(detalle)');
    expect(
      /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(CODIGO),
      'Volvió a aparecer el cálculo de las 24 h en la bandeja.',
    ).toBe(false);
  });
});
