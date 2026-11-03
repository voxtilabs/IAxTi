import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fuenteLimpia } from '@iaxti/core/testing';
import { intervaloDelRespaldo } from '../components/bandeja/bandeja';

/**
 * El respaldo pide según si alguien está mirando (#1198).
 *
 * Medido en staging el 02-11: el worker no publicaba nada al canal de la
 * bandeja —falta `SUPABASE_SERVICE_ROLE_KEY` y `realtimeConsumers` devuelve
 * lista vacía— así que lo único que movía la bandeja era este respaldo, a 20
 * segundos. Mandar un WhatsApp y esperar veinte segundos a verlo aparecer se
 * siente como una bandeja muerta, y es lo primero que alguien hace para probar
 * el producto.
 */
describe('cada cuánto pide el respaldo', () => {
  it('mirando: rápido', () => {
    expect(intervaloDelRespaldo('visible', true)).toBe(4_000);
  });

  it('visible pero sin foco: lento, como antes', () => {
    // `visibilityState` y no `hasFocus` para decidir si pedir: una pestaña
    // visible en el segundo monitor sí se mira, aunque el teclado esté en otra.
    expect(intervaloDelRespaldo('visible', false)).toBe(20_000);
  });

  it('escondida: NO pide', () => {
    // Lo que de verdad baja la carga total. Hoy una pestaña olvidada en otro
    // escritorio pide tres veces por minuto para siempre.
    expect(intervaloDelRespaldo('hidden', false)).toBeNull();
    expect(intervaloDelRespaldo('hidden', true)).toBeNull();
  });

  it('el rápido es MÁS rápido que el lento, y ninguno es cero', () => {
    // Anti-vacuidad: si alguien iguala las dos constantes, las pruebas de
    // arriba siguen pasando y el arreglo deja de existir.
    const mirando = intervaloDelRespaldo('visible', true)!;
    const quieto = intervaloDelRespaldo('visible', false)!;
    expect(mirando).toBeLessThan(quieto);
    expect(mirando).toBeGreaterThan(0);
  });
});

describe('el efecto cablea la decisión y limpia lo que escucha', () => {
  const fuente = fuenteLimpia(
    readFileSync(join(__dirname, '../components/bandeja/bandeja.tsx'), 'utf8'),
  );

  it('usa la función y no un número suelto', () => {
    expect(fuente).toContain('intervaloDelRespaldo(document.visibilityState, document.hasFocus())');
    // Ningún setInterval con una constante a mano: ahí volvería el defecto.
    expect(fuente).not.toMatch(/setInterval\([^,]+,\s*RESPALDO_MS\)/);
  });

  it('escucha los tres eventos que cambian si alguien mira', () => {
    for (const evento of ['visibilitychange', 'focus', 'blur']) {
      expect(fuente).toContain(`addEventListener('${evento}'`);
      expect(fuente).toContain(`removeEventListener('${evento}'`);
    }
  });

  it('al volver de escondida pide una vez antes de reanudar', () => {
    // Sin esto, volver a la pestaña deja hasta cuatro segundos de pantalla
    // vieja justo cuando la persona vuelve a mirar.
    expect(fuente).toContain('if (recienVuelta) traer()');
  });

  /**
   * El respaldo trae la lista Y la conversación abierta (#1221).
   *
   * Traía solo la lista, y por eso había que recargar la pestaña para ver que
   * el bot contestó. Lo peor no era que faltara: era que la lista SÍ se movía
   * —cambiaba el último mensaje y el no leído— así que la pantalla parecía
   * viva mientras el panel del medio estaba congelado.
   *
   * Hoy el respaldo es el único camino: `SUPABASE_SERVICE_ROLE_KEY` no está en
   * el compose de staging, así que el canal de realtime nunca conecta.
   */
  it('trae la lista Y la conversación abierta, como el realtime', () => {
    const cuerpo = fuente.slice(fuente.indexOf('const traer = ()'));
    expect(cuerpo.slice(0, 200)).toContain('cargarLista()');
    expect(cuerpo.slice(0, 200)).toContain('cargarConversacion(abierta)');
    // Y que el intervalo use eso, no la lista pelada: ahí volvería el defecto.
    expect(fuente).toContain('setInterval(traer, cada)');
    expect(fuente).not.toMatch(/setInterval\(\(\) => void cargarLista\(\)/);
  });
});
