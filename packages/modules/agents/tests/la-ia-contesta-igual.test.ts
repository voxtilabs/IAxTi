import { describe, expect, it } from 'vitest';
import { iaSettings, TASKS } from '../domain/config';
import { diagnosticarLaIa } from '../application/diagnostico-ia';

/**
 * La IA contesta aunque el ajuste guardado apunte a otro proveedor (#665).
 *
 * Lo que pasó: los ajustes de un negocio apuntaban a un proveedor de antes de
 * que ADR-0025 moviera todas las tareas de texto a GLM. El ambiente tenía GLM.
 * La IA no contestó **nunca**, y el mensaje decía «el proveedor de IA aún no
 * tiene llave configurada en este ambiente» — culpando al ambiente, que sí tenía
 * una, en vez de decir que había que cambiar un ajuste.
 *
 * El código ya caía al por defecto cuando el proveedor no podía HACER la tarea
 * —«es capacidad, no preferencia, y fallar en cada audio recibido sería peor que
 * respetar la preferencia»—. Faltaba la otra mitad: un proveedor sin credencial
 * tampoco puede hacer nada.
 *
 * Con UNA excepción que no se toca: `soloProveedor`. Eso es un compromiso
 * escrito sobre por dónde pasan los datos del cliente (ADR-0025 §7), y cambiarlo
 * en silencio sería romperlo sin que nadie se entere.
 */

const soloGlm = (p: string) => p === 'glm';
const ninguno = () => false;

describe('la IA contesta igual (#665)', () => {
  it('con el ajuste apuntando a Google y solo GLM disponible, usa GLM', () => {
    const ia = iaSettings(
      { ia: { tasks: { sugerir: { provider: 'google', model: 'gemini-flash-latest' } } } },
      soloGlm,
    );
    expect(ia.tasks.sugerir.provider).toBe('glm');
    // Y el modelo acompaña: quedarse con `gemini-flash-latest` apuntando a GLM
    // sería un 404 en cada mensaje.
    expect(ia.tasks.sugerir.model).toContain('glm');
  });

  it('sin decirle qué hay disponible, NADA cambia', () => {
    // Guardar ajustes no decide sobre credenciales: ahí el negocio tiene que ver
    // lo que eligió, no lo que este ambiente puede.
    const ia = iaSettings({
      ia: { tasks: { sugerir: { provider: 'google', model: 'gemini-flash-latest' } } },
    });
    expect(ia.tasks.sugerir.provider).toBe('google');
  });

  it('si el proveedor elegido SÍ tiene llave, se respeta', () => {
    const ia = iaSettings(
      { ia: { tasks: { sugerir: { provider: 'google', model: 'gemini-flash-latest' } } } },
      (p) => p === 'google' || p === 'glm',
    );
    expect(ia.tasks.sugerir.provider).toBe('google');
    expect(ia.tasks.sugerir.model).toBe('gemini-flash-latest');
  });

  it('con NINGUNA credencial no inventa nada: deja el elegido y que falle con su mensaje', () => {
    const ia = iaSettings(
      { ia: { tasks: { sugerir: { provider: 'google', model: 'gemini-flash-latest' } } } },
      ninguno,
    );
    expect(ia.tasks.sugerir.provider).toBe('google');
  });

  it('`soloProveedor` NO se cae nunca: es un compromiso escrito, no una preferencia', () => {
    // Un negocio pidió por escrito que sus datos pasen solo por Google. Que este
    // ambiente no tenga esa llave NO autoriza a mandárselos a otro.
    const ia = iaSettings({ ia: { soloProveedor: 'google' } }, soloGlm);
    for (const t of TASKS) {
      if (t === 'transcribir') continue; // esa ya caía por capacidad, desde antes
      expect(ia.tasks[t].provider, t).toBe('google');
    }
  });

  it('todas las tareas de texto terminan en un proveedor con llave', () => {
    const ia = iaSettings({}, soloGlm);
    const sinLlave = TASKS.filter((t) => !soloGlm(ia.tasks[t].provider));
    // `transcribir` es la excepción conocida: el catálogo de NVIDIA no publica
    // modelos de audio, comprobado contra el proveedor.
    expect(sinLlave).toEqual(['transcribir']);
  });
});

describe('y el diagnóstico lo dice (#665)', () => {
  it('avisa cuando lo guardado apunta a un proveedor que no está', () => {
    const d = diagnosticarLaIa({
      settings: { ia: { tasks: { sugerir: { provider: 'google', model: 'x' } } } },
      hayLlave: soloGlm,
    });
    const paso = d.pasos.find((p) => p.id === 'proveedor_guardado');
    expect(paso, 'el diagnóstico no ve lo que el negocio tiene guardado').toBeTruthy();
    expect(paso!.estado).toBe('atencion');
    // No es 'mal': la IA funciona igual. Decirlo como falla sería mentir al revés.
    expect(d.problema).toBeNull();
    expect(paso!.detalle).toContain('proponerle una respuesta');
  });

  it('y no inventa el aviso cuando lo guardado sí tiene llave', () => {
    const d = diagnosticarLaIa({
      settings: { ia: { tasks: { sugerir: { provider: 'glm', model: 'x' } } } },
      hayLlave: soloGlm,
    });
    expect(d.pasos.find((p) => p.id === 'proveedor_guardado')).toBeUndefined();
  });
});
