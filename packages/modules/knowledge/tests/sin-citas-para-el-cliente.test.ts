import { describe, expect, it } from 'vitest';
import { knowledgeContext } from '../application/search';
import type { KnowledgeResult } from '../application/search';

/**
 * El bloque de conocimiento no pide cita cuando la respuesta va directo al
 * cliente (#1239).
 *
 * Medido CON el arreglo de #1207 ya desplegado:
 *
 *     → tengo una ferreteria
 *     ← IAxTi es un asistente con IA para ferreterías… pásate por el stand.
 *       ([Por tipo de negocio], [VoxTi Labs], [Alcances y límites])
 *
 * #1207 dejó la instrucción de citar donde estaba y agregó una
 * contra-instrucción en `formatoAutonomo`. Dos instrucciones opuestas en el
 * mismo prompt, y el modelo elige: eligió citar. No es un modelo que se portó
 * mal — es un prompt que se contradice, y la salida es estocástica por
 * construcción. La forma de que no haga algo no es pedírselo dos veces.
 */
const resultado: KnowledgeResult = {
  hits: [
    { sourceId: 's1', sourceName: 'Por tipo de negocio', content: 'ferretería: precio por cantidad', score: 0.9 },
    { sourceId: 's2', sourceName: 'VoxTi Labs', content: 'empresa chilena de desarrollo', score: 0.8 },
  ] as KnowledgeResult['hits'],
  cached: false,
  expiredSources: [],
};

describe('el bloque de conocimiento según quién lo lee (#1239)', () => {
  it('por defecto pide la cita: el borrador lo revisa una persona', () => {
    const bloque = knowledgeContext(resultado)!;
    expect(bloque).toContain('NOMBRE EXACTO');
    expect(bloque).toContain('[Por tipo de negocio]');
  });

  /**
   * Y con `citar: false` el nombre NO está en el prompt. Eso es lo que lo
   * hace distinto de pedirle que no lo diga: lo que no está no se puede
   * copiar.
   */
  it('con citar:false no pide la cita Y no incluye los nombres', () => {
    const bloque = knowledgeContext(resultado, { citar: false })!;
    expect(bloque).not.toContain('NOMBRE EXACTO');
    expect(bloque, 'el nombre de la fuente no viaja al prompt').not.toContain('Por tipo de negocio');
    expect(bloque, 'ni el de la otra').not.toContain('VoxTi Labs');
    // El contenido sí, que es para lo que existe el bloque.
    expect(bloque).toContain('ferretería: precio por cantidad');
    expect(bloque).toContain('NO menciones de dónde salió');
  });

  /**
   * `citar: true` explícito y `{}` se comportan igual que no pasar nada: el
   * defecto es citar, porque el camino por defecto del producto es la
   * sugerencia que una persona revisa.
   */
  it('el defecto es citar, y no se cambia por pasar un objeto vacío', () => {
    expect(knowledgeContext(resultado, {})).toBe(knowledgeContext(resultado));
    expect(knowledgeContext(resultado, { citar: true })).toBe(knowledgeContext(resultado));
  });

  it('el aviso de fuentes vencidas viaja en los dos casos', () => {
    const vencidas: KnowledgeResult = { ...resultado, expiredSources: ['Lista de precios'] };
    expect(knowledgeContext(vencidas)).toContain('VENCIDAS');
    expect(knowledgeContext(vencidas, { citar: false })).toContain('VENCIDAS');
  });
});
