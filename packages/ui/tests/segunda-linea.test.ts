import { describe, expect, it } from 'vitest';
import { nombreVisible, segundaLinea } from '../src/react/canal';

/**
 * La segunda línea existe solo si no repite a la primera (#1120).
 *
 * Medido antes de esto en la bandeja: con un contacto sin nombre —el caso
 * normal, un WhatsApp nuevo llega sin nombre— el mismo número salía CUATRO
 * veces en una pantalla, porque la cabecera del chat y la ficha dibujaban
 * ambas su subtítulo siempre.
 */
describe('segundaLinea', () => {
  it('con nombre, el teléfono va abajo', () => {
    const c = { name: 'Ana Pérez', phone: '+56955550101', channel: 'whatsapp' };
    expect(nombreVisible(c)).toBe('Ana Pérez');
    expect(segundaLinea(c)).toBe('+56955550101');
  });

  it('sin nombre, no hay segunda línea: el teléfono YA es el título', () => {
    const c = { name: null, phone: '+56955550101', channel: 'whatsapp' };
    expect(nombreVisible(c)).toBe('+56955550101');
    expect(segundaLinea(c)).toBeNull();
  });

  it('sin teléfono tampoco: nada de un párrafo vacío que igual ocupa su alto', () => {
    // Instagram sin número: el título lo arma el canal.
    const c = { name: null, phone: null, channel: 'instagram', identity: 'ig_998877' };
    expect(nombreVisible(c)).toContain('…998877');
    expect(segundaLinea(c)).toBeNull();
  });

  it('con nombre y canal sin teléfono, tampoco inventa', () => {
    expect(segundaLinea({ name: 'Ana', phone: null, channel: 'instagram' })).toBeNull();
  });

  it('se compara contra lo que SE VE arriba, no contra `name`', () => {
    // Si algún día `nombreVisible` cambiara de criterio, esto sigue siendo
    // correcto: la regla es «no repitas la primera línea», no «mira si hay
    // nombre».
    const c = { name: null, phone: '+56955550101', channel: 'whatsapp', identity: 'x' };
    expect(segundaLinea(c)).toBe(nombreVisible(c) === c.phone ? null : c.phone);
  });
});
