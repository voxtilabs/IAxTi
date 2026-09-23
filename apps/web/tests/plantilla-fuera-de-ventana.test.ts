import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlantilla, variablesDePlantilla } from '../lib/api';

/**
 * Elegir una plantilla fuera de las 24 h (#460).
 *
 * `POST /plantillas/:id/enviar` existía desde #44 y la bandeja mostraba el
 * botón **deshabilitado**, con un texto que decía que las plantillas
 * llegaban «con la conexión real de WhatsApp». Ya habían llegado. Pasadas
 * las 24 h, quien atiende no le podía escribir a nadie: la mitad de para
 * qué sirve el producto quedaba apagada por un botón sin pantalla detrás.
 */
const CHAT = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'chat.tsx'), 'utf8');
const BANDEJA = readFileSync(join(__dirname, '..', 'components', 'bandeja', 'bandeja.tsx'), 'utf8');

describe('elegir plantilla', () => {
  it('el botón ya no está deshabilitado', () => {
    const boton = CHAT.slice(CHAT.indexOf('Elegir plantilla') - 400, CHAT.indexOf('Elegir plantilla'));
    expect(boton).not.toMatch(/disabled(\s|$|\})/);
    expect(boton).toContain('setDialogoPlantilla(true)');
  });

  it('solo ofrece las aprobadas', () => {
    // Una en revisión falla en el proveedor y la persona nunca la recibe;
    // el error llegaría días después y sin explicación.
    expect(CHAT).toMatch(/filter\(\(p\) => p\.status === 'approved'\)/);
  });

  it('se piden al abrir, no al cargar la bandeja', () => {
    // El módulo whatsapp puede estar apagado en el plan: pedirlas siempre
    // sería un 404 en cada conversación abierta.
    expect(CHAT).toContain('if (plantillas === null) void onCargarPlantillas();');
  });

  it('manda a la conversación abierta con sus valores', () => {
    expect(BANDEJA).toMatch(/\/plantillas\/\$\{templateId\}\/enviar/);
    expect(BANDEJA).toContain('conversationId: seleccion, valores');
  });

  it('no deja mandarla con un valor en blanco', () => {
    // El servidor exige exactamente tantos valores como variables; un
    // hueco se vería como un `{{2}}` crudo en el teléfono del cliente.
    expect(CHAT).toMatch(/valores\.some\(\(v\) => !v\.trim\(\)\)/);
  });

  it('recarga la conversación después de mandarla', () => {
    const i = BANDEJA.indexOf('/plantillas/${templateId}/enviar');
    expect(BANDEJA.slice(i, i + 400)).toContain('cargarConversacion(seleccion)');
  });

  it('si no hay ninguna aprobada, dice dónde crearlas', () => {
    // Meta se demora en revisarlas: enterarse el día que se necesitan es
    // enterarse tarde.
    expect(CHAT).toContain('/ajustes/plantillas');
  });
});

describe('las variables se cuentan como en el servidor', () => {
  it('ordenadas y sin repetir', () => {
    expect(variablesDePlantilla('Hola {{2}}, {{1}} y otra vez {{2}}')).toEqual([1, 2]);
  });

  it('sin variables, ninguna', () => {
    expect(variablesDePlantilla('Hola, ya está listo')).toEqual([]);
  });

  it('la vista previa deja ver el hueco que falta', () => {
    // Con el valor vacío mostramos {{2}} tal cual: es exactamente lo que
    // vería el cliente si se mandara así.
    expect(renderPlantilla('Hola {{1}}, tu hora del {{2}}', ['Ana', ''])).toBe(
      'Hola Ana, tu hora del {{2}}',
    );
  });
});
