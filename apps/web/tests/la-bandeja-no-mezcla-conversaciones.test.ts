import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';

/**
 * Al cambiar de conversación no queda NADA de la anterior (#588).
 *
 * ## El defecto, y por qué lo abrió un cambio que mejoraba otra cosa
 *
 * #761 partió el arranque de una conversación en dos llamadas: la urgente
 * —hilo y mensajes, que la pantalla espera— y la ficha, que entra sola. Eso
 * está bien y es lo que evita que el copiloto lento deje la bandeja en blanco.
 *
 * Pero movió el momento en que llega cada dato. Cuando vuelve la urgente,
 * `detalle` ya es el contacto NUEVO y lo de la ficha sigue siendo del ANTERIOR
 * hasta la segunda respuesta. El efecto de selección reiniciaba cuatro cosas y
 * había que reiniciar diez: durante esa ventana la pantalla muestra **las notas
 * internas de un cliente bajo el nombre de otro**.
 *
 * En una bandeja compartida eso no es un parpadeo: es leer sobre Ana lo que el
 * equipo escribió sobre Pedro, y contestarle en consecuencia.
 *
 * ## Por qué esta prueba mira el código
 *
 * Las pruebas del web corren sin DOM. Lo que se fija es la FORMA del defecto:
 * que el efecto que reacciona a `seleccion` limpie TODO lo que depende de la
 * conversación. Un dato nuevo que se agregue sin su reinicio reaparece acá.
 */
const BANDEJA = join(__dirname, '..', 'components', 'bandeja', 'bandeja.tsx');

describe('cambiar de conversación no deja datos de la anterior (#588)', () => {
  const codigo = fuenteLimpia(readFileSync(BANDEJA, 'utf8'));

  /** El cuerpo del efecto que reacciona al cambio de selección. */
  const efecto = (() => {
    const i = codigo.indexOf('if (seleccion) {');
    expect(i, 'no se encontró el efecto de selección: ¿se renombró?').toBeGreaterThan(-1);
    return codigo.slice(i, codigo.indexOf('void cargarConversacion(seleccion);', i));
  })();

  it('limpia todo lo que depende de la conversación, no solo el hilo', () => {
    // La lista es explícita a propósito. Un `expect(cuantos).toBeGreaterThan(8)`
    // pasaría con el reinicio equivocado puesto nueve veces, y el día que
    // alguien agregue un dato nuevo el número no le va a decir cuál falta.
    for (const dato of [
      'setDetalle',
      'setMensajes',
      'setLimites',
      'setNotas',
      'setSugerencia',
      'setSinSugerencia',
      'setAnalisis',
      'setFichaDelContacto',
      'setEtiquetasDelContacto',
      'setInscripciones',
    ]) {
      expect(efecto, `${dato} no se reinicia al cambiar de conversación`).toContain(dato);
    }
  });

  it('todo estado que el arranque de la ficha escribe, se reinicia acá', () => {
    /**
     * La parte que de verdad cuida esto: la correspondencia.
     *
     * Se leen los `setX` que escribe el manejador del arranque de la ficha y se
     * exige que cada uno aparezca en el reinicio. Así, agregar una pieza nueva
     * a la ficha sin reiniciarla pone esto rojo — que es el camino exacto por el
     * que entró el defecto.
     *
     * Y no es una prueba de adorno: la lista escrita a mano de arriba me había
     * quedado corta en DOS (`setSecuencias` y `setInscripciones`) y esto las
     * encontró. La primera además estaba en el agregado equivocado —el catálogo
     * de secuencias es del negocio, no del contacto— y se mudó al arranque del
     * shell, que es lo que de verdad arregló ese caso: un dato que no cambia con
     * el contacto no tiene por qué descartarse al cambiar de contacto.
     */
    const manejador = codigo.slice(
      codigo.indexOf('/arranque/ficha'),
      codigo.indexOf('.catch(() => {});', codigo.indexOf('/arranque/ficha')),
    );
    expect(manejador, 'no se encontró el manejador de la ficha').not.toBe('');
    const escritos = [...manejador.matchAll(/\bset([A-Z]\w+)\(/g)].map((m) => `set${m[1]}`);
    expect(escritos.length, 'el manejador de la ficha no escribe ningún estado').toBeGreaterThan(3);
    for (const setter of new Set(escritos)) {
      expect(
        efecto,
        `${setter} se escribe con la ficha pero no se reinicia al cambiar de conversación`,
      ).toContain(setter);
    }
  });
});
