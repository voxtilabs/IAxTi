import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MODELS,
  iaSettings,
  proveedorPermitidoParaTarea,
  redactPII,
  vaRedactadoAlProveedor,
} from '../domain/config';

/**
 * Qué le podemos mandar a cada proveedor.
 *
 * La historia en dos actos. ADR-0023 (21-09) restringió `glm` a
 * `clasificar` con prompt redactado, porque Zhipu no publicaba qué hace
 * con lo que recibe. ADR-0025 §7 (25-09) lo abre TODO por decisión del
 * dueño — y con un hecho nuevo: la cuenta real sirve GLM por el catálogo
 * de NVIDIA, así que el destino de los datos es NVIDIA, no Zhipu directo.
 *
 * El MECANISMO de sin-garantías se queda vivo (lista vacía): el próximo
 * proveedor sin papeles entra a la lista y la política vuelve a regir sin
 * escribir código.
 */
describe('qué tareas acepta cada proveedor (ADR-0025)', () => {
  it('a GLM se le da todo lo de texto', () => {
    for (const t of ['clasificar', 'sugerir', 'responder', 'configurar', 'conocer', 'resumir', 'analizar'] as const) {
      expect(proveedorPermitidoParaTarea('glm', t), t).toBe(true);
    }
  });

  it('transcribir NO: es capacidad, no política', () => {
    // La transcripción entra como parte de AUDIO y el endpoint de GLM es
    // de texto. Configurárselo fallaría en cada audio recibido.
    expect(proveedorPermitidoParaTarea('glm', 'transcribir')).toBe(false);
    expect(proveedorPermitidoParaTarea('google', 'transcribir')).toBe(true);
  });

  it('nada sale redactado hacia GLM: ya no está en la lista', () => {
    expect(vaRedactadoAlProveedor('glm', 'clasificar')).toBe(false);
    expect(vaRedactadoAlProveedor('glm', 'sugerir')).toBe(false);
  });

  it('la redacción sigue viva para Langfuse y el dataset', () => {
    const limpio = redactPII('Hola, soy Ana, +56 9 1234 5678, ana@correo.cl, RUT 12.345.678-9');
    expect(limpio).not.toContain('1234 5678');
    expect(limpio).not.toContain('ana@correo.cl');
  });
});

describe('la configuración del tenant, con GLM abierto', () => {
  it('GLM para sugerir SE RESPETA, con su modelo', () => {
    const s = iaSettings({
      ia: { tasks: { sugerir: { provider: 'glm', model: 'z-ai/glm-5.3-flash' } } },
    });
    expect(s.tasks.sugerir.provider).toBe('glm');
    expect(s.tasks.sugerir.model).toBe('z-ai/glm-5.3-flash');
  });

  it('GLM para transcribir cae al por defecto, con su modelo', () => {
    // No falla: un audio de un cliente esperando transcripción no es el
    // lugar para enseñar una limitación. Cae y sigue.
    const s = iaSettings({
      ia: { tasks: { transcribir: { provider: 'glm', model: 'z-ai/glm-5.3' } } },
    });
    expect(s.tasks.transcribir.provider).toBe('google');
    // El modelo cae con el proveedor: `z-ai/glm-5.3` apuntando a Google
    // sería un 404 en cada audio.
    expect(s.tasks.transcribir.model).not.toBe('z-ai/glm-5.3');
  });

  it('GLM ya puede ser el modelo económico', () => {
    const s = iaSettings({ ia: { economico: { provider: 'glm', model: 'z-ai/glm-5.3-flash' } } });
    expect(s.economico?.provider).toBe('glm');
  });

  it('los por-defecto son GLM salvo transcribir', () => {
    for (const [task, tm] of Object.entries(DEFAULT_TASK_MODELS)) {
      if (task === 'transcribir') expect(tm.provider).toBe('google');
      else expect(tm.provider, task).toBe('glm');
    }
  });

  it('«solo Gemini» por tenant sigue funcionando: resguardo de ADR-0025', () => {
    // Al cliente que lo pida se le configura task por task y se respeta.
    const s = iaSettings({
      ia: {
        tasks: Object.fromEntries(
          ['clasificar', 'sugerir', 'responder', 'configurar', 'conocer', 'resumir', 'analizar', 'transcribir'].map(
            (t) => [t, { provider: 'google', model: 'gemini-flash-latest' }],
          ),
        ),
      },
    });
    for (const t of Object.values(s.tasks)) expect(t.provider).toBe('google');
  });
});
