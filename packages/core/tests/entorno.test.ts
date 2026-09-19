import { describe, expect, it, vi } from 'vitest';
import { enteroDeEntorno } from '../src/entorno';

// `Number(process.env.X ?? 120)` se lee bien y falla mal. Lo que sigue es
// cada forma en que falla, con el nombre de lo que rompía.

describe('enteroDeEntorno', () => {
  it('sin la variable usa el por-defecto y no se queja', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('NO_EXISTE', 3000, { env: {} })).toBe(3000);
    // No estar configurada NO es un error: es lo normal.
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });

  it('la cadena VACÍA es el caso que muerde, y `??` no la atrapa', () => {
    // Number('') es 0, y `??` solo cubre null y undefined. Dejar una
    // variable en blanco en el panel es la forma normal de "desactivarla".
    const enBlanco: string | undefined = '';
    expect(Number(enBlanco ?? 3000)).toBe(0); // lo que pasaba antes
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '' } })).toBe(3000);
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '   ' } })).toBe(3000);
    // En blanco es "no configurada", no "configurada mal": no avisa.
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });

  it('basura cae al por-defecto Y LO DICE', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: 'tres mil' } })).toBe(3000);
    // Callarse sería repetir el problema en otro lugar: alguien puso un
    // valor con intención y no está pasando nada de lo que espera.
    expect(avisos).toHaveBeenCalledOnce();
    const texto = String(avisos.mock.calls[0][0]);
    expect(texto).toContain('PORT="tres mil"');
    expect(texto).toContain('Se usa 3000');
    avisos.mockRestore();
  });

  it('un cero explícito tampoco pasa: es el que hace listen() al azar', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '0' } })).toBe(3000);
    expect(enteroDeEntorno('WHATSAPP_MSGS_PER_SECOND', 10, { env: { WHATSAPP_MSGS_PER_SECOND: '0' } })).toBe(10);
    expect(avisos).toHaveBeenCalledTimes(2);
    avisos.mockRestore();
  });

  it('negativos y decimales raros tampoco', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(enteroDeEntorno('X', 5, { env: { X: '-1' } })).toBe(5);
    expect(enteroDeEntorno('X', 5, { env: { X: 'NaN' } })).toBe(5);
    expect(enteroDeEntorno('X', 5, { env: { X: 'Infinity' } })).toBe(5);
    avisos.mockRestore();
  });

  it('un valor bueno pasa tal cual', () => {
    expect(enteroDeEntorno('PORT', 3000, { env: { PORT: '8080' } })).toBe(8080);
    // Y `min: 0` para los que sí aceptan cero con sentido (una pausa de 0 ms
    // es "sin pausa", y eso es una configuración válida).
    expect(enteroDeEntorno('PAUSA', 4000, { env: { PAUSA: '0' }, min: 0 })).toBe(0);
  });
});
