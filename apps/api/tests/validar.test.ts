import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { validar, textoRequerido, diaRequerido } from '../src/validar';

/**
 * El puente entre zod y el formato de error de la API (#524).
 *
 * Lo que se prueba acá es justo lo que se pierde al adoptar zod sin pensar: el
 * formato del error, que es contrato de la API (SPEC §28) y del que dependen el
 * SDK y las pantallas; y el mensaje, que lo lee alguien que está con un cliente
 * esperando, no quien programa.
 */
const Esquema = z.object({
  nombre: textoRequerido('Dinos cómo se llama.'),
  dia: diaRequerido('La fecha va como AAAA-MM-DD.').optional(),
  monto: z.number().int().positive('El monto tiene que ser mayor que cero.').optional(),
});

function fallo(valor: unknown) {
  try {
    validar(Esquema, valor);
  } catch (err) {
    if (err instanceof BadRequestException) {
      return err.getResponse() as { code: string; message: string; details: unknown[] };
    }
    throw err;
  }
  throw new Error('Esperábamos que fallara y pasó.');
}

describe('validar con zod (#524)', () => {
  it('lo válido pasa y vuelve tipado y limpio', () => {
    const r = validar(Esquema, { nombre: '  Barbería Don Juan  ', dia: '2026-09-26' });
    // El `.trim()` del esquema es parte de la validación: un nombre con
    // espacios al final se guardaba así y después no calzaba en ninguna
    // búsqueda.
    expect(r.nombre).toBe('Barbería Don Juan');
    expect(r.dia).toBe('2026-09-26');
  });

  it('el código sigue siendo VALIDATION_ERROR', () => {
    // No es cosmético: el SDK y las pantallas distinguen por `code`, no por
    // el texto ni por el status.
    expect(fallo({}).code).toBe('VALIDATION_ERROR');
  });

  it('el mensaje es el ESCRITO en el esquema, no el de zod', () => {
    // Lo que zod diría por su cuenta es «Invalid input: expected string,
    // received undefined». Quien lo lee está atendiendo a alguien.
    //
    // Y el caso de abajo es el que importa más: el campo AUSENTE. Ahí falla el
    // TIPO y no el largo, así que un `.min(1, mensaje)` solo no alcanza — el
    // mensaje tiene que estar también en el tipo. Esta prueba falló primero y
    // por eso los atajos lo ponen en los dos lugares.
    for (const entrada of [{}, { nombre: '' }, { nombre: '   ' }, { nombre: 42 }]) {
      const r = fallo(entrada);
      expect(r.message, JSON.stringify(entrada)).toBe('Dinos cómo se llama.');
      expect(r.message).not.toContain('Invalid');
      expect(r.message).not.toContain('expected');
    }
  });

  it('los details traen TODOS los campos, con su campo y su mensaje', () => {
    // El mensaje de arriba es el que se lee; los details son para pintar
    // varios campos a la vez en un formulario.
    const r = fallo({ dia: 'ayer', monto: -5 });
    const campos = (r.details as Array<{ field?: string }>).map((d) => d.field).sort();
    expect(campos).toEqual(['dia', 'monto', 'nombre']);
    expect(r.details).toContainEqual({ field: 'dia', message: 'La fecha va como AAAA-MM-DD.' });
  });

  it('un campo anidado se nombra con su ruta completa', () => {
    // Sin la ruta, un formulario no sabe qué pintar en rojo cuando el error
    // está dentro de un objeto.
    const Anidado = z.object({ pago: z.object({ monto: z.number('El monto va en número.') }) });
    try {
      validar(Anidado, { pago: { monto: 'mil' } });
      throw new Error('debía fallar');
    } catch (err) {
      const r = (err as BadRequestException).getResponse() as { details: Array<{ field?: string }> };
      expect(r.details[0].field).toBe('pago.monto');
    }
  });

  it('un cuerpo que no es objeto no revienta: se rechaza como los demás', () => {
    // `JSON.parse('"hola"')` es un string válido, y antes llegaba a un
    // `body?.campo` que daba undefined y seguía adelante.
    for (const basura of [null, undefined, 'hola', 42, []]) {
      expect(fallo(basura).code).toBe('VALIDATION_ERROR');
    }
  });

  it('lo que el esquema no declara NO pasa al resto del código', () => {
    // Por omisión zod descarta las claves de más, y eso es lo que queremos:
    // un campo que el navegador manda y la ruta no espera no puede terminar
    // en un INSERT por accidente.
    const r = validar(Esquema, { nombre: 'X', colado: 'sí', tenantId: 'otro-negocio' });
    expect(r).not.toHaveProperty('colado');
    expect(r).not.toHaveProperty('tenantId');
  });
});
