import { describe, expect, it } from 'vitest';
import { formatoAutonomo } from '../domain/escalation';

/**
 * Una foto no puede dejar la conversación muda (#1208).
 *
 * Medido en staging: dos fotos firmadas, una sin pie y otra con pie. Las dos
 * recibieron el aviso de escalada. Y el acta mostraba la respuesta ya escrita,
 * con 3 fuentes usadas y confianza 0,7, tirada con
 * `escalar: true, motivo_escalar: "fuera_de_conocimiento"`.
 *
 * La regla de arriba —«si el dato no está en el contexto: escalar»— cubre un
 * adjunto que el modelo no puede ver, tal como está escrita. Nada la desmentía.
 * Es la otra mitad de la frase que arregló #1020 («que tú no puedas agendar NO
 * es fuera_de_conocimiento»), y va en el mismo párrafo.
 */
describe('un adjunto que no se puede ver no es para escalar (#1208)', () => {
  const plano = (s: string) => s.replace(/\s+/g, ' ');

  it('el prompt autónomo lo dice, y con el nombre del motivo que se usaba mal', () => {
    const prompt = plano(formatoAutonomo({ moneyLimitClp: null }));
    expect(prompt).toContain('Un ADJUNTO que no puedes ver');
    expect(prompt).toContain('tampoco es "fuera_de_conocimiento"');
    // Y qué hacer en su lugar, que es lo que al final lee el cliente.
    expect(prompt).toContain('desde acá no lo ves');
  });

  it('y NO va en la lista cuyo encabezado significa escalar', () => {
    const prompt = formatoAutonomo({ moneyLimitClp: null });
    const desde = prompt.indexOf('REGLAS NO NEGOCIABLES');
    const lista = prompt.slice(desde, prompt.indexOf('\n\n', desde));
    expect(lista).not.toMatch(/adjunto/i);
  });
});
