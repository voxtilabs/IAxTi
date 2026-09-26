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

  it('«solo Gemini» cubre TODAS las tareas, incluidas las que no existían', () => {
    // Era configuración tarea por tarea, y así se rompía solo: al agregar
    // `configuracion_conversada` (#493), el negocio que había pedido solo
    // Gemini pasaba a GLM en esa tarea SIN QUE NADIE CAMBIARA NADA. Un
    // cliente que pide un proveedor por escrito no puede depender de que
    // alguien se acuerde de ampliarle una lista en el próximo despliegue.
    const s = iaSettings({ ia: { soloProveedor: 'google' } });
    for (const [tarea, tm] of Object.entries(s.tasks)) {
      expect(tm.provider, tarea).toBe('google');
      // Y con un modelo DE ESE proveedor: `z-ai/glm-5.3` apuntando a Google
      // sería un 404 en cada corrida.
      expect(tm.model, tarea).toMatch(/gemini/);
    }
    expect(s.soloProveedor).toBe('google');
  });

  it('las que razonan quedan en la gama alta del proveedor pedido', () => {
    const s = iaSettings({ ia: { soloProveedor: 'google' } });
    expect(s.tasks.configuracion_conversada.model).toContain('pro');
    expect(s.tasks.configurar.model).toContain('pro');
    expect(s.tasks.clasificar.model).toContain('flash');
  });

  it('un modelo elegido a mano se respeta si es de ese proveedor', () => {
    const s = iaSettings({
      ia: {
        soloProveedor: 'google',
        tasks: { sugerir: { provider: 'google', model: 'gemini-2.5-flash' } },
      },
    });
    expect(s.tasks.sugerir.model).toBe('gemini-2.5-flash');
    // Y uno de OTRO proveedor se ignora: es lo que el negocio pidió no usar.
    const otro = iaSettings({
      ia: { soloProveedor: 'google', tasks: { sugerir: { provider: 'glm', model: 'z-ai/glm-5.3' } } },
    });
    expect(otro.tasks.sugerir.provider).toBe('google');
  });

  it('con proveedor único, el económico no puede ser de otro', () => {
    // La cuota al 100 % sería la puerta de atrás para mandarle datos al que
    // el negocio pidió no usar.
    const s = iaSettings({
      ia: { soloProveedor: 'google', economico: { provider: 'glm', model: 'z-ai/glm-5.3-flash' } },
    });
    expect(s.economico).toBeNull();
  });
});
