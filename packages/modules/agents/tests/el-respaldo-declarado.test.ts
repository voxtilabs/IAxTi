import { describe, expect, it } from 'vitest';
import {
  ORDEN_DE_RESPALDO,
  PROVIDERS,
  iaSettings,
  type Provider,
} from '../domain/config';

/**
 * A quién se recurre cuando falta una llave es una DECISIÓN, no el orden de
 * un array (#858).
 *
 * Era el orden de `PROVIDERS`, la lista de elegibles, y el propio comentario
 * de ese array lo decía: «un orden de array decidiendo con qué proveedor se
 * atiende». El problema no era que el orden estuviera mal —estaba bien— sino
 * que agregar un proveedor elegible cambiaba a quién se recurre en silencio.
 *
 * Lo que eso costó una vez: el 11-10 `google` estaba primero, de cuando
 * Gemini era el defecto. GLM no tenía llave, el respaldo recorrió la lista,
 * encontró google —la única con llave, y sin saldo— y las ocho tareas de
 * texto murieron mientras el diagnóstico decía `ia ✓`.
 */
describe('el respaldo declarado (#858)', () => {
  it('están los cuatro elegibles, una sola vez cada uno', () => {
    // Lo que esta guarda compra: agregar un proveedor a `PROVIDERS` sin
    // decidir dónde cae en el respaldo no compila el PR. Antes lo decidía la
    // posición en la que alguien lo hubiera escrito.
    expect([...ORDEN_DE_RESPALDO].sort()).toEqual([...PROVIDERS].sort());
    expect(new Set(ORDEN_DE_RESPALDO).size).toBe(ORDEN_DE_RESPALDO.length);
  });

  it('se recurre en el orden declarado, no en el de la lista de elegibles', () => {
    // `PROVIDERS` va openai, glm, anthropic, google. El respaldo va openai,
    // glm, google, anthropic. Con solo esos dos con llave, el orden de la
    // lista de elegibles diría `anthropic` y el declarado dice `google`.
    const conLlave = new Set<Provider>(['google', 'anthropic']);
    const tasks = iaSettings(
      // Pide un proveedor que no tiene llave: ahí entra el respaldo.
      { ia: { soloProveedor: null, tasks: { resumir: { provider: 'glm', model: 'x' } } } },
      (p) => conLlave.has(p),
    ).tasks;
    expect(tasks.resumir.provider).toBe('google');
  });

  it('el castigado se saltea, y el orden sigue siendo el declarado', () => {
    // Con google castigado —acaba de fallar por algo que no se arregla
    // reintentando— se pasa al siguiente DEL ORDEN, no al siguiente de
    // `PROVIDERS`.
    const conLlave = new Set<Provider>(['google', 'anthropic']);
    const tasks = iaSettings(
      { ia: { soloProveedor: null, tasks: { resumir: { provider: 'glm', model: 'x' } } } },
      (p) => conLlave.has(p),
      (p) => p === 'google',
    ).tasks;
    expect(tasks.resumir.provider).toBe('anthropic');
  });

  it('`transcribir` no cae en uno que no transcribe, aunque esté primero', () => {
    // Sin OpenAI, GLM precede a Google en el orden pero no tiene puerto de
    // audio. Se salta por capacidad, no por el nombre ni la posición.
    const tasks = iaSettings({ ia: {} }, p => p !== 'openai').tasks;
    expect(tasks.transcribir.provider).toBe('google');
  });
});
