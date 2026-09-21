import { describe, expect, it } from 'vitest';
import { DEFINICIONES, OBJETIVOS, componerPrompt, resolverObjetivo } from '../domain/objetivo';

/**
 * Con quién habla cada asistente (#410).
 *
 * Los cinco primeros hablan con el cliente del negocio por WhatsApp. El de
 * estadísticas habla con el DUEÑO, dentro del producto. No es un objetivo
 * más: cambian las herramientas, el tono, lo que está permitido y hasta si
 * hay una ventana de 24 horas.
 */
describe('el destinatario del asistente', () => {
  it('cada objetivo declara con quién habla', () => {
    for (const id of OBJETIVOS) {
      expect(['cliente', 'dueño'], id).toContain(DEFINICIONES[id].destinatario);
    }
  });

  it('los del cliente no usan herramientas del dueño, ni al revés', () => {
    // Un asistente de WhatsApp con acceso a los números del negocio se los
    // contaría a un cliente. Y uno de estadísticas con `send_reply` podría
    // escribirle a alguien.
    for (const id of OBJETIVOS) {
      const d = DEFINICIONES[id];
      const deNumeros = d.tools.filter((t) => t.startsWith('analytics.'));
      if (d.destinatario === 'cliente') {
        expect(deNumeros, `${id} no debería ver los números`).toEqual([]);
      } else {
        // Ninguno del dueño puede escribirle a nadie. No se exige que TENGA
        // herramientas: el de configuración no tiene ninguna a propósito,
        // porque propone y no aplica (#415).
        const escriben = d.tools.filter((t) => /send_reply|create_|book|link/.test(t));
        expect(escriben, `${id} no debería poder escribirle a nadie`).toEqual([]);
      }
    }
  });

  it('al dueño no se le dice "en un momento te ayuda una persona"', () => {
    // La persona ES él. Se le dice qué falta, que es lo accionable.
    const sinAnalytics = resolverObjetivo('estadisticas', null, []);
    const prompt = componerPrompt(null, sinAnalytics)!;
    expect(prompt).not.toMatch(/te ayuda una persona/);
    expect(prompt).toMatch(/falta analytics/);

    const cliente = resolverObjetivo('agendar', null, []);
    expect(componerPrompt(null, cliente)!).toMatch(/te ayuda una persona/);
  });

  it('el de números sí tiene con qué mirar los números', () => {
    // La otra mitad de la regla de arriba, para el único que debe tenerlas:
    // sin herramientas, un asistente de estadísticas no responde — inventa.
    const deNumeros = DEFINICIONES.estadisticas.tools.filter((t) => t.startsWith('analytics.'));
    expect(deNumeros.length).toBeGreaterThan(0);
  });

  it('el de números tiene prohibido estimar, explícitamente', () => {
    // Es la instrucción que más importa: un modelo al que le falta un dato
    // lo rellena, y un número inventado en un reporte es peor que no tener
    // reporte.
    const i = DEFINICIONES.estadisticas.instruccion;
    expect(i).toMatch(/nunca calcules de memoria|ni estimes/);
    expect(i).toMatch(/cero/);
    expect(i).toMatch(/sin datos|no hay datos/);
  });

  it('el de números no persigue nada: no tiene datos mínimos ni evento de éxito', () => {
    // Los otros cierran algo. Este responde; medirlo por "conversiones"
    // sería inventarle una meta que no tiene.
    expect(DEFINICIONES.estadisticas.datosMinimos).toEqual([]);
    expect(DEFINICIONES.estadisticas.eventoDeExito).toEqual([]);
  });

  it('hay al menos uno de cada lado', () => {
    const destinos = new Set(OBJETIVOS.map((id) => DEFINICIONES[id].destinatario));
    expect(destinos).toEqual(new Set(['cliente', 'dueño']));
  });
});
