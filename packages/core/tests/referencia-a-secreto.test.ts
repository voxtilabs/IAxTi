import { describe, expect, it } from 'vitest';
import {
  esNombreDeVariable,
  exigirNombreDeVariable,
  refParaMostrar,
} from '../src/referencia-a-secreto';

/**
 * Las credenciales van por referencia: en la base el NOMBRE de la variable,
 * nunca el valor (SPEC §17).
 *
 * El runbook de producción afirmaba que «los canales y los pagos» rechazaban
 * una credencial pegada. Solo lo hacía `payments`; `channels` —que guarda la
 * llave del WhatsApp por el que pasa toda la conversación del negocio— hacía
 * el INSERT con el valor tal cual (#801).
 */
describe('una referencia a secreto es un nombre de variable (#801)', () => {
  it('acepta las referencias que el repo usa de verdad', () => {
    for (const ref of [
      'ZAVU_API_KEY',
      'AUDIT_EXPORT_SECRET',
      'R2_BUCKET_ADJUNTOS',
      'FLOW_WEBHOOK_CRED',
      'X',
    ]) {
      expect(esNombreDeVariable(ref), ref).toBe(true);
      expect(exigirNombreDeVariable(ref, 'campo')).toBe(ref);
    }
  });

  /**
   * El caso que importa. La guarda anterior miraba espacios, `:` y `=`, y la
   * llave que de verdad usamos no tiene ninguno de los tres: habría pasado
   * por buena en el módulo que SÍ comprobaba.
   */
  it('rechaza la forma de los secretos de los proveedores que usamos', () => {
    for (const secreto of [
      'zv_live_ac73feebf3f29cd43fcd3222624272ecd2a854133b050eea',
      'zv_test_60fed749ddb9e63ccf367ccbb620bb56385b15281d',
      'nvapi-kL3mj2nvvbnmjDJC5nk9R4I00xqK0',
      'sk-proj-abc123',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.x',
    ]) {
      expect(esNombreDeVariable(secreto), secreto.slice(0, 12)).toBe(false);
      expect(() => exigirNombreDeVariable(secreto, 'campo')).toThrow(/NOMBRE de la variable/);
    }
  });

  it('rechaza lo que la guarda vieja ya rechazaba, y lo vacío', () => {
    for (const malo of ['apiKey:secretKey-real', 'CLAVE=1234', 'DOS PALABRAS', '', '   ', null, undefined]) {
      expect(esNombreDeVariable(malo)).toBe(false);
      expect(() => exigirNombreDeVariable(malo, 'campo')).toThrow();
    }
  });

  /**
   * Y el mensaje no repite lo que la persona escribió. Si pegó el secreto,
   * repetirlo en el error lo manda al log, al cuerpo de la respuesta y a la
   * pantalla — que es justo el camino por el que se filtraba.
   */
  it('el mensaje de rechazo no incluye lo que se intentó guardar', () => {
    const secreto = 'zv_live_ac73feebf3f29cd43fcd3222624272ecd2a854133b050eea';
    const err = (() => {
      try {
        exigirNombreDeVariable(secreto, 'la referencia de la credencial');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain(secreto);
    expect(err!.message).toContain('la referencia de la credencial');
    expect(err!.message).toContain('ZAVU_API_KEY'); // dice cómo se ve uno bueno
  });

  describe('mostrarla en un error', () => {
    it('el nombre sí se dice: no es secreto y es lo que hay que ir a arreglar', () => {
      expect(refParaMostrar('ZAVU_API_KEY')).toBe('ZAVU_API_KEY');
    });

    it('lo que no tiene forma de nombre NO se imprime', () => {
      const secreto = 'zv_live_ac73feebf3f29cd43fcd3222624272ecd2a854133b050eea';
      const mostrado = refParaMostrar(secreto);
      expect(mostrado).not.toContain('zv_live');
      expect(mostrado).toBe('(la referencia guardada no es un nombre de variable)');
    });

    it('sin referencia lo dice, y no imprime "null"', () => {
      expect(refParaMostrar(null)).toBe('(sin referencia)');
      expect(refParaMostrar(undefined)).toBe('(sin referencia)');
      expect(refParaMostrar('')).toBe('(sin referencia)');
    });
  });
});
