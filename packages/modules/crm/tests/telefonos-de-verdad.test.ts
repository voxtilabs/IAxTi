import { describe, expect, it } from 'vitest';
import { normalizePhone, tipoDeLinea } from '../domain/validation';

/**
 * Teléfonos validados contra el plan de numeración real (#582).
 *
 * Lo que había eran cinco expresiones regulares que solo entendían Chile, y de
 * los cuatro problemas que el issue nombra el que más duele es el cuarto:
 *
 *     if (/^09?\d{8}$/.test(digits)) return `+569${digits.slice(-8)}`;
 *
 * Tomar «los últimos ocho dígitos» asumiendo que el prefijo sobra, con un
 * número mal tipeado, **inventa** uno válido en vez de rechazarlo. No falla:
 * acierta mal. Y el mensaje le llega a otra persona.
 *
 * Por eso la prueba que más importa de este archivo es la última: que ninguna
 * entrada produzca un número DISTINTO del que se tipeó.
 */
describe('lo que la gente tipea sigue funcionando (#582)', () => {
  it.each([
    ['+56 9 1234 5678', '+56912345678'],
    ['9 1234 5678', '+56912345678'],
    ['56912345678', '+56912345678'],
    ['+14085551234', '+14085551234'],
    // El cero de los celulares chilenos de antes. La librería lo rechaza
    // —Chile eliminó el prefijo nacional— y se sigue aceptando a propósito:
    // hay gente que todavía lo escribe así.
    ['091234-5678', '+56912345678'],
    ['0 9 1234 5678', '+56912345678'],
  ])('%s → %s', (entrada, esperado) => {
    expect(normalizePhone(entrada)).toBe(esperado);
  });
});

describe('lo que antes pasaba y no debía (#582)', () => {
  it('un país que no existe se rechaza', () => {
    // `+99999999999` pasaba la primera regla —once dígitos, empieza con 9— y
    // el contacto se guardaba. El rechazo lo daba el proveedor, y desde #556
    // eso es un fallo permanente que termina leyendo el vendedor.
    expect(() => normalizePhone('+99999999999')).toThrow(/Teléfono inválido/);
  });

  it('un número con la cantidad equivocada de dígitos se rechaza', () => {
    // `+5622345678` pasaba por tener forma internacional. No es un número
    // chileno: a los fijos de Santiago les falta un dígito así.
    expect(() => normalizePhone('+5622345678')).toThrow(/Teléfono inválido/);
    expect(() => normalizePhone('12345')).toThrow(/Teléfono inválido/);
    expect(() => normalizePhone('+5612345')).toThrow(/Teléfono inválido/);
  });

  it('lo que no es un teléfono se rechaza sin explotar', () => {
    for (const basura of ['', '   ', 'no es telefono', '+', '++56912345678']) {
      expect(() => normalizePhone(basura), `aceptó ${JSON.stringify(basura)}`).toThrow(
        /Teléfono inválido/,
      );
    }
  });
});

describe('un número local de otro país, si se sabe el país (#582)', () => {
  it.each([
    ['011 4444 5555', 'AR', '+541144445555'],
    ['987 654 321', 'PE', '+51987654321'],
    ['(11) 98765-4321', 'BR', '+5511987654321'],
  ])('%s en %s → %s', (entrada, pais, esperado) => {
    expect(normalizePhone(entrada, pais as 'AR')).toBe(esperado);
  });

  it('y sin saber el país, un local se lee como chileno — que es lo que significa', () => {
    // `987 654 321` es un celular chileno válido Y un celular peruano válido.
    // Con Chile por defecto se guarda como chileno, y eso NO es un defecto que
    // se pueda arreglar adivinando: es lo que significa un número sin código de
    // país. Queda escrito acá para que nadie «arregle» esto suponiendo.
    expect(normalizePhone('987 654 321')).toBe('+56987654321');
  });
});

describe('ninguna entrada produce un número distinto del tipeado (#582)', () => {
  it.each([
    // Un dígito de más: antes el `slice(-8)` se comía el que sobraba y
    // devolvía un número válido que NO era el que alguien escribió.
    '0912345678 9',
    '9 1234 56789',
    '+56 9 1234 56789',
    '56 9 1234 56789',
  ])('%s se rechaza en vez de adivinar', (entrada) => {
    let resultado: string | null = null;
    try {
      resultado = normalizePhone(entrada);
    } catch {
      resultado = null;
    }
    // Si se aceptó, al menos tiene que contener TODOS los dígitos que se
    // escribieron: lo que no se puede hacer es devolver otro número.
    if (resultado !== null) {
      const tipeados = entrada.replace(/\D/g, '');
      expect(
        resultado.replace(/\D/g, ''),
        `${entrada} se normalizó a ${resultado}, que no tiene los dígitos tipeados`,
      ).toContain(tipeados.replace(/^0/, ''));
    }
  });
});

describe('móvil, fijo, o no se sabe (#582)', () => {
  it('en Chile se decide con el plan de numeración', () => {
    expect(tipoDeLinea('+56987654321')).toBe('movil');
    expect(tipoDeLinea('+56229123456')).toBe('fijo');
    expect(tipoDeLinea('+56412345678')).toBe('fijo');
  });

  it('fuera de Chile dice que no sabe, en vez de inventar una regla por país', () => {
    // Tres estados y no un booleano: para Chile la librería no puede
    // decidirlo —con `min` no hay tipos y con `max` los chilenos vuelven como
    // `FIXED_LINE_OR_MOBILE`— así que un booleano tendría que mentir en una de
    // las dos direcciones. Y la dirección peligrosa es decir «no es móvil» de
    // un celular y bloquear un envío legítimo.
    expect(tipoDeLinea('+14085551234')).toBe('no_se');
    expect(tipoDeLinea('+541144445555')).toBe('no_se');
  });
});

describe('los teléfonos ya guardados no se tocan (#582)', () => {
  it.each([
    '+56912345678',
    '+56987654321',
    '+14085551234',
    '+541144445555',
  ])('%s sigue siendo válido', (guardado) => {
    // Criterio 8 del issue, y es el que decide si esto se puede desplegar: las
    // filas de `contacts.phone` son E.164 y pasan por `normalizePhone` cada vez
    // que alguien las vuelve a guardar. Si la validación nueva rechazara uno de
    // los que ya están, el contacto se volvería ineditable.
    expect(normalizePhone(guardado)).toBe(guardado);
  });
});
