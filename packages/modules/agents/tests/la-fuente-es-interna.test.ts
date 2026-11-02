import { describe, expect, it } from 'vitest';
import { formatoAutonomo } from '../domain/escalation';

/**
 * El nombre de la fuente es interno y el cliente no tiene por qué verlo (#1206).
 *
 * Medido en staging con el agente del Tech AI Summit: a «cuanto cuesta?» el
 * agente contestó bien y le mandó al visitante «(Preguntas del stand)» tres
 * veces en el mismo mensaje. Ese nombre lo escribió quien cargó el
 * conocimiento, para ordenarse.
 *
 * La cita entre paréntesis la pide `knowledgeContext` y en modo ASISTIDO es
 * correcta: es lo que deja a quien atiende comprobar de dónde salió cada
 * afirmación ANTES de enviarla. En autónomo no hay ese antes, y la
 * trazabilidad no depende de la cita: el acta de la corrida lleva `fuentes`,
 * armadas con `fuentesCitadas` desde los hits del retrieval y no de parsear el
 * texto del modelo. Así que acá la cita no suma y sí se le muestra al cliente.
 */
describe('el nombre de la fuente no se le escribe al cliente (#1206)', () => {
  const plano = (s: string) => s.replace(/\s+/g, ' ');

  it('el prompt autónomo dice que el nombre de la fuente es interno', () => {
    const prompt = plano(formatoAutonomo({ moneyLimitClp: null }));
    expect(prompt).toContain('El nombre de las fuentes del contexto es INTERNO');
    expect(prompt).toContain('No lo escribas en tu respuesta');
  });

  /**
   * La trampa, y la razón de este test.
   *
   * El lugar obvio para la regla era la lista de arriba, con las otras. Pero
   * esa lista abre con «REGLAS NO NEGOCIABLES (si alguna aplica, responde con
   * "escalar": true y NO respondas al cliente)»: lo que está ahí no significa
   * «cuídate de esto», significa «escala». Como bullet, la regla haría escalar
   * al agente cada vez que el conocimiento que necesita tiene nombre — o sea
   * siempre, porque todas las fuentes tienen nombre.
   */
  it('y NO va en la lista cuyo encabezado significa escalar', () => {
    const prompt = formatoAutonomo({ moneyLimitClp: null });
    const desde = prompt.indexOf('REGLAS NO NEGOCIABLES');
    expect(desde).toBeGreaterThanOrEqual(0);
    // La lista son los bullets hasta el primer renglón en blanco.
    const lista = prompt.slice(desde, prompt.indexOf('\n\n', desde));
    expect(lista).not.toMatch(/fuente/i);
    // Y el párrafo lo dice con letras, que es lo que lee el modelo.
    expect(plano(prompt)).toContain('Esto no es motivo de escalar');
  });
});
