import { describe, expect, it } from 'vitest';
import {
  iaSettings,
  proveedorPermitidoParaTarea,
  redactPII,
  vaRedactadoAlProveedor,
} from '../domain/config';

/**
 * Qué le podemos mandar a un proveedor cuyos términos no dicen qué hacen
 * con lo que reciben (ADR-0023, #54).
 *
 * El punto sutil: `redactPII` ya existía y protegía a Langfuse y al dataset
 * de evaluación. Al MODELO el texto iba entero, y tiene que ir entero —
 * redactar lo que se le pide interpretar rompe la respuesta. La excepción
 * es `clasificar`: etiquetar un mensaje no necesita saber de quién es.
 */
describe('qué tareas acepta un proveedor sin garantías', () => {
  it('a GLM solo se le da clasificar', () => {
    expect(proveedorPermitidoParaTarea('glm', 'clasificar')).toBe(true);
    for (const t of ['sugerir', 'responder', 'configurar', 'conocer', 'resumir', 'analizar'] as const) {
      expect(proveedorPermitidoParaTarea('glm', t), t).toBe(false);
    }
  });

  it('a Google y Anthropic, todas: sus términos sí dicen qué hacen', () => {
    for (const p of ['google', 'anthropic'] as const) {
      for (const t of ['clasificar', 'sugerir', 'responder', 'configurar'] as const) {
        expect(proveedorPermitidoParaTarea(p, t), `${p}/${t}`).toBe(true);
      }
    }
  });

  it('lo que sale hacia GLM va redactado; hacia Google, entero', () => {
    expect(vaRedactadoAlProveedor('glm', 'clasificar')).toBe(true);
    expect(vaRedactadoAlProveedor('google', 'clasificar')).toBe(false);
    // Y no hay caso donde vaya sin redactar a un proveedor sin garantías:
    // las tareas que no sobreviven a la redacción no llegan a él.
    expect(vaRedactadoAlProveedor('glm', 'sugerir')).toBe(false);
    expect(proveedorPermitidoParaTarea('glm', 'sugerir')).toBe(false);
  });

  it('la redacción de verdad borra lo que identifica', () => {
    const limpio = redactPII('Hola, soy Ana, +56 9 1234 5678, ana@correo.cl, RUT 12.345.678-9');
    expect(limpio).not.toContain('1234 5678');
    expect(limpio).not.toContain('ana@correo.cl');
  });
});

describe('la configuración del tenant no puede saltarse la política', () => {
  it('GLM configurado para sugerir cae al por defecto, con su modelo', () => {
    // No falla: un mensaje de un cliente esperando respuesta no es el lugar
    // para enseñar una política. Cae al por defecto y sigue.
    const s = iaSettings({
      ia: { tasks: { sugerir: { provider: 'glm', model: 'glm-4.6' } } },
    });
    expect(s.tasks.sugerir.provider).toBe('google');
    // Y el modelo cae con él: `glm-4.6` apuntando a Google sería un 404 en
    // cada mensaje entrante.
    expect(s.tasks.sugerir.model).not.toBe('glm-4.6');
  });

  it('GLM configurado para clasificar SÍ se respeta, con su modelo', () => {
    const s = iaSettings({
      ia: { tasks: { clasificar: { provider: 'glm', model: 'glm-4.6' } } },
    });
    expect(s.tasks.clasificar.provider).toBe('glm');
    expect(s.tasks.clasificar.model).toBe('glm-4.6');
  });

  it('GLM no puede ser el modelo económico: sería la puerta de atrás', () => {
    // El económico se usa para CUALQUIER tarea cuando la cuota llega al
    // 100 %. Dejarlo ahí haría que `sugerir` terminara en él justo el día
    // de más volumen.
    const s = iaSettings({ ia: { economico: { provider: 'glm', model: 'glm-4.6' } } });
    expect(s.economico).toBeNull();

    const bueno = iaSettings({ ia: { economico: { provider: 'google', model: 'gemini-flash-latest' } } });
    expect(bueno.economico?.provider).toBe('google');
  });
});
