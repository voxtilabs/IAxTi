import { describe, expect, it } from 'vitest';
import {
  MAX_CHATS,
  MAX_MENSAJES_POR_CHAT,
  chatsParaLeer,
  leerLoAprendido,
  pedidoDeAprendizaje,
  redactarParaLaIA,
  type ChatParaAprender,
} from '../domain/aprender-de-chats';

/**
 * Lo que sale hacia el proveedor de IA cuando IAxTi aprende de los chats del
 * negocio (#1406, ADR-0039). Son conversaciones de clientes de la pyme: la
 * prueba que importa es que en el pedido NO quede nada que identifique a una
 * persona, escrito como lo escribe la gente de verdad.
 */
const DATOS = {
  telefonos: ['+56 9 8765 4321', '+56987654321', '987654321', '9 8765 4321', '9-8765-4321', '+56 2 2345 6789', '+1 (415) 555-0100'],
  correos: ['camila.rojas@gmail.com', 'ventas+pedidos@peluqueria.cl'],
  ruts: ['12.345.678-9', '12345678-k', '9.876.543-2'],
  tarjetas: ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111'],
  cuentas: ['00123456789', '1234567890'],
  enlaces: ['https://pago.cl/checkout?token=abc123&rut=12345678'],
};

const chat = (textos: Array<[boolean, string]>, base = '2026-09-12'): ChatParaAprender => ({
  mensajes: textos.map(([delNegocio, texto], i) => ({
    delNegocio,
    texto,
    fecha: `${base}T10:${String(i).padStart(2, '0')}:00.000Z`,
  })),
});

describe('lo que sale hacia la IA', () => {
  it('ningún teléfono, correo, RUT, tarjeta, cuenta ni enlace sobrevive la redacción', () => {
    for (const [tipo, valores] of Object.entries(DATOS)) {
      for (const v of valores) {
        const r = redactarParaLaIA(`Hola, te dejo el dato: ${v}. Gracias`);
        expect(r, `${tipo}: ${v}`).not.toContain(v);
        // Ni siquiera un trozo largo de dígitos del dato.
        expect(r.match(/\d{6,}/), `${tipo}: ${v} dejó dígitos`).toBeNull();
      }
    }
  });

  it('lo que importa para aprender se queda: precios, horas y fechas cortas', () => {
    const r = redactarParaLaIA('El corte de mujer vale $15.000 y el color desde $35.000. Abrimos a las 10:00, el martes 12-09.');
    expect(r).toContain('$15.000');
    expect(r).toContain('$35.000');
    expect(r).toContain('10:00');
    expect(r).toContain('12-09');
  });

  it('el pedido completo no lleva ningún dato de cliente, y dice quién habló sin nombres', () => {
    const chats = [
      chat([
        [false, `Hola soy Camila, mi número es ${DATOS.telefonos[3]} y mi correo ${DATOS.correos[0]}`],
        [true, 'Hola, ¿en qué te ayudo?'],
        [false, '¿Cuánto vale el corte de mujer?'],
        [true, 'El corte de mujer vale $15.000'],
        [false, `Pago con la tarjeta ${DATOS.tarjetas[0]}, rut ${DATOS.ruts[0]}`],
      ]),
    ];
    const { system, prompt } = pedidoDeAprendizaje(chatsParaLeer(chats));
    const todo = `${system}\n${prompt}`;
    for (const valores of Object.values(DATOS)) for (const v of valores) expect(todo).not.toContain(v);
    expect(prompt).toContain('Cliente (2026-09-12): ¿Cuánto vale el corte de mujer?');
    expect(prompt).toContain('Negocio (2026-09-12): El corte de mujer vale $15.000');
  });
});

describe('el alcance del ADR', () => {
  it('a lo más 50 chats, 30 mensajes cada uno (los últimos), sin grupos ni mensajes sin texto', () => {
    const muchos = Array.from({ length: 60 }, () =>
      chat(Array.from({ length: 40 }, (_, i): [boolean, string] => [i % 2 === 0, `mensaje ${i}`])),
    );
    muchos.unshift({ esGrupo: true, mensajes: [{ delNegocio: false, texto: 'del grupo', fecha: '2026-09-12T10:00:00Z' }] });
    muchos[1]!.mensajes.push({ delNegocio: false, texto: null, fecha: '2026-09-12T11:00:00Z' });
    const leidos = chatsParaLeer(muchos);
    expect(leidos).toHaveLength(MAX_CHATS);
    expect(leidos.every((l) => l.length === MAX_MENSAJES_POR_CHAT)).toBe(true);
    expect(leidos[0]!.at(-1)).toContain('mensaje 39');
    expect(leidos.flat().some((l) => l.includes('del grupo'))).toBe(false);
  });
});

describe('lo que vuelve del proveedor', () => {
  it('se lee aunque venga envuelto en texto, y un precio queda marcado para confirmar', () => {
    const r = leerLoAprendido(
      'Aquí va:\n{"tono":"Cercano, de tú, sin emojis.","entradas":[{"pregunta":"¿Cuánto vale el corte de mujer?","respuesta":"$15.000","tipo":"precio","fecha":"2026-09-12"}]}',
    );
    expect(r.tono).toBe('Cercano, de tú, sin emojis.');
    expect(r.entradas[0]).toMatchObject({ tipo: 'precio', aviso: 'Precio visto en un chat del 12-09; confírmalo antes de aprobar.' });
  });

  it('lo que el modelo copió de un cliente se vuelve a redactar antes de guardarse', () => {
    const r = leerLoAprendido(
      JSON.stringify({ tono: 'x', entradas: [{ pregunta: '¿Cómo pago?', respuesta: `Transfiere a la cuenta ${DATOS.cuentas[0]} o llama al ${DATOS.telefonos[3]}`, tipo: 'pago' }] }),
    );
    expect(r.entradas[0]!.respuesta).not.toContain(DATOS.cuentas[0]);
    expect(r.entradas[0]!.respuesta).not.toContain(DATOS.telefonos[3]);
  });

  it('una entrada que no valida se descarta sin tirar las demás; basura no rompe', () => {
    const r = leerLoAprendido(JSON.stringify({ entradas: [{ pregunta: 'x' }, { pregunta: '¿Despachan?', respuesta: 'Sí, a todo Santiago', tipo: 'inventado' }] }));
    expect(r.entradas).toEqual([{ pregunta: '¿Despachan?', respuesta: 'Sí, a todo Santiago', tipo: 'otro' }]);
    expect(leerLoAprendido('no es json')).toEqual({ tono: null, entradas: [] });
  });
});
