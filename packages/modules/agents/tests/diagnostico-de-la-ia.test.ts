import { describe, expect, it } from 'vitest';
import { diagnosticarLaIa } from '../application/diagnostico-ia';

/**
 * Por qué la IA no hace nada (#614).
 *
 * El canal tiene su diagnóstico desde #526. La IA no tenía nada: si falta una
 * llave, el modelo lanza, el error sube como «Algo falló de nuestro lado», y
 * quien mira la pantalla no puede saber que el problema es una variable de
 * entorno ausente.
 *
 * Eso es lo que hace que alguien diga «nunca pude probar nada». No que no
 * funcione: que no se pueda ver POR QUÉ no funciona.
 */

const NINGUNA = () => false;
const TODAS = () => true;
const SOLO = (...ps: string[]) => (p: string) => ps.includes(p);

describe('sin ninguna llave, lo dice y dice qué poner (#614)', () => {
  const d = diagnosticarLaIa({ settings: null, hayLlave: NINGUNA });

  it('el problema es el primero: los proveedores', () => {
    // El orden importa: si no hay ninguna llave, el resto de los pasos son ruido.
    expect(d.problema).toBe('proveedores');
    expect(d.pasos[0]!.id).toBe('proveedores');
    expect(d.pasos[0]!.estado).toBe('mal');
  });

  it('nombra las VARIABLES, para que se sepa qué configurar', () => {
    const q = d.pasos[0]!.queHacer ?? '';
    expect(q).toContain('GLM_API_KEY');
    expect(q).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('y dice qué se rompe, en castellano y no en nombres de tarea', () => {
    const tareas = d.pasos.find((p) => p.id === 'tareas')!;
    expect(tareas.estado).toBe('mal');
    // «sugerir» no le dice nada a nadie; «proponerle una respuesta a quien
    // atiende» sí.
    expect(tareas.detalle).toContain('proponerle una respuesta');
    expect(tareas.detalle).toContain('entender un audio');
  });
});

describe('con todas las llaves, la IA puede trabajar (#614)', () => {
  const d = diagnosticarLaIa({ settings: null, hayLlave: TODAS });

  it('no hay problema y no se inventa uno', () => {
    expect(d.problema).toBeNull();
    expect(d.pasos.every((p) => p.estado === 'bien')).toBe(true);
  });
});

describe('el proveedor que el negocio EXIGE (#614)', () => {
  it('si lo pidió y no está, es el problema, y con su motivo', () => {
    // Este caso es peor que no tener IA: hay un compromiso escrito con el
    // cliente y el producto no lo puede cumplir ni avisar.
    const d = diagnosticarLaIa({
      settings: { ia: { soloProveedor: 'google' } },
      hayLlave: SOLO('glm'),
    });
    const paso = d.pasos.find((p) => p.id === 'proveedor_exigido')!;
    expect(paso.estado).toBe('mal');
    expect(paso.detalle).toContain('google');
    expect(paso.queHacer).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    // Y no manda a usar otro sin más: manda a hablar con el negocio.
    expect(paso.queHacer).toContain('habla con el negocio');
  });

  it('si lo pidió y está, queda verde', () => {
    const d = diagnosticarLaIa({
      settings: { ia: { soloProveedor: 'glm' } },
      hayLlave: SOLO('glm'),
    });
    expect(d.pasos.find((p) => p.id === 'proveedor_exigido')!.estado).toBe('bien');
  });

  it('si no pidió ninguno, el paso no aparece: no se inventa un aviso', () => {
    const d = diagnosticarLaIa({ settings: null, hayLlave: TODAS });
    expect(d.pasos.some((p) => p.id === 'proveedor_exigido')).toBe(false);
  });
});

describe('con una sola llave, se distingue lo que sí de lo que no (#614)', () => {
  const d = diagnosticarLaIa({ settings: null, hayLlave: SOLO('glm') });

  it('no es «mal»: es «atención», porque algo sí funciona', () => {
    // Pintar todo en rojo cuando la mitad anda hace que nadie lea el rojo.
    expect(d.pasos.find((p) => p.id === 'proveedores')!.estado).toBe('bien');
    const tareas = d.pasos.find((p) => p.id === 'tareas')!;
    expect(['bien', 'atencion']).toContain(tareas.estado);
  });

  it('avisa de los que no tienen llave, sin exigirlos todos', () => {
    const q = d.pasos.find((p) => p.id === 'proveedores')!.queHacer ?? '';
    expect(q).toContain('No hace falta tenerlos todos');
  });
});

describe('ninguna llave se filtra al diagnóstico (#614)', () => {
  it('no aparece ni un pedazo de ningún valor', () => {
    // Un diagnóstico es una pantalla que alguien va a compartir por WhatsApp
    // para pedir ayuda. Es la misma regla que el paso de la credencial del canal.
    const antes = process.env.GLM_API_KEY;
    process.env.GLM_API_KEY = 'zv_super_secreto_no_debe_salir_123456';
    try {
      const texto = JSON.stringify(diagnosticarLaIa({ settings: null }));
      expect(texto).not.toContain('zv_super_secreto');
      expect(texto).not.toContain('123456');
      // Y los NOMBRES de variable sí, que es lo único accionable.
      //
      // Ojo con lo que NO se afirma: que aparezca `GLM_API_KEY`. Esa es la que
      // acabamos de configurar, así que correctamente NO sale en «lo que falta».
      // Mi primera versión de esta prueba lo afirmaba y se puso roja — y tenía
      // razón la prueba: yo estaba comprobando lo contrario de lo que quería.
      expect(texto).toMatch(/_API_KEY/);
    } finally {
      if (antes === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = antes;
    }
  });
});
