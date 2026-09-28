import { describe, expect, it } from 'vitest';
import { motivoDelProveedor } from '../application/motivo-del-proveedor';

/**
 * Por qué NO contestó el proveedor (#402).
 *
 * Las respuestas de abajo son las REALES, no inventadas: la de Gemini sin
 * saldo se capturó el 21-09 pegándole a la API con la llave de Lino.
 */
describe('el motivo del proveedor', () => {
  it('sin saldo NO es reintentable, y lo dice sin la URL del proveedor', () => {
    const d = motivoDelProveedor({
      statusCode: 402,
      message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects',
    });
    expect(d.motivo).toBe('sin_saldo');
    expect(d.reintentable).toBe(false);
    // "Intenta de nuevo" con saldo cero le hace perder el tiempo al dueño.
    expect(d.message).not.toMatch(/intenta de nuevo/i);
    expect(d.message).toContain('saldo');
    // Nunca la URL ni la llave.
    expect(d.message).not.toMatch(/https?:\/\//);
  });

  it('cuota agotada SÍ es reintentable, y se distingue de sin saldo', () => {
    // Gemini devuelve RESOURCE_EXHAUSTED para las DOS cosas. Por código
    // solo, se leerían igual — y una se arregla esperando y la otra pagando.
    const cuota = motivoDelProveedor({ statusCode: 429, message: 'RESOURCE_EXHAUSTED: rate limit exceeded' });
    expect(cuota.motivo).toBe('cuota_agotada');
    expect(cuota.reintentable).toBe(true);

    const saldo = motivoDelProveedor({ statusCode: 402, message: 'RESOURCE_EXHAUSTED: prepayment credits are depleted' });
    expect(saldo.motivo).toBe('sin_saldo');
    expect(saldo.reintentable).toBe(false);
  });

  it('llave inválida o vencida', () => {
    for (const e of [
      { statusCode: 401, message: 'Invalid authentication credentials' },
      { statusCode: 403, message: 'permission denied' },
      { message: 'API key not valid. Please pass a valid API key.' },
    ]) {
      expect(motivoDelProveedor(e).motivo, JSON.stringify(e)).toBe('llave_invalida');
      expect(motivoDelProveedor(e).reintentable).toBe(false);
    }
  });

  it('modelo que ya no existe manda a cambiarlo, no a reintentar', () => {
    const d = motivoDelProveedor({ statusCode: 404, message: 'models/gemini-1.0-pro is not found' });
    expect(d.motivo).toBe('modelo_no_disponible');
    expect(d.reintentable).toBe(false);
    expect(d.message).toMatch(/configuración del asistente/);
  });

  it('el estado anidado también cuenta', () => {
    // Algunos SDK lo dejan en `response` o en `cause`.
    expect(motivoDelProveedor({ response: { status: 429 }, message: 'x' }).motivo).toBe('cuota_agotada');
    expect(motivoDelProveedor({ cause: { statusCode: 401 }, message: 'x' }).motivo).toBe('llave_invalida');
  });

  it('lo que no reconocemos se llama desconocido, no se disfraza', () => {
    // Esto importa: el controller SOLO traduce cuando no es desconocido. Si
    // acá devolviéramos cualquier cosa, un fallo de una tool se leería como
    // un problema del proveedor y el mensaje real se perdería.
    for (const e of [
      { message: 'la conversación no existe' },
      new Error('socket hang up'),
      null,
      undefined,
      'texto suelto',
    ]) {
      expect(motivoDelProveedor(e).motivo, String(e)).toBe('desconocido');
    }
  });

  it('sin llave se reconoce por el mensaje del propio producto', () => {
    const d = motivoDelProveedor(
      new Error('El proveedor google no tiene llave configurada (GOOGLE_GENERATIVE_AI_API_KEY).'),
    );
    expect(d.motivo).toBe('sin_llave');
    expect(d.reintentable).toBe(false);
  });
});

/**
 * Con quién falló (#677).
 *
 * El 27/09 la plataforma dijo «El proveedor de IA rechazó la petición por falta
 * de saldo» mientras la llave que estaba puesta —GLM_API_KEY con una `nvapi-` de
 * NVIDIA— contestaba 200, con tool-calling incluido. El mensaje no nombraba a
 * nadie, así que no había forma de saber si era una clasificación equivocada,
 * otra llave, u otro proveedor. Costó una hora.
 *
 * Y duele desde #666 y no antes: ese arreglo hace que un asistente cuyo
 * proveedor no tiene credencial caiga al que sí la tenga. «El proveedor de IA»,
 * en singular y sin nombre, puede estar señalando al que no falló — y quien lee
 * el mensaje va a ir a revisar la cuenta equivocada.
 */
describe('el mensaje dice con quién falló (#677)', () => {
  const casos: Array<[string, unknown]> = [
    ['sin saldo', new Error('insufficient balance')],
    ['cuota agotada', Object.assign(new Error('rate limit exceeded'), { status: 429 })],
    ['llave inválida', Object.assign(new Error('invalid api key'), { status: 401 })],
    ['modelo no disponible', Object.assign(new Error('model not found'), { status: 404 })],
    ['sin llave', new Error('El proveedor glm no tiene llave configurada (GLM_API_KEY).')],
    ['desconocido', new Error('socket hang up')],
  ];

  for (const [nombre, error] of casos) {
    it(`${nombre}: nombra el proveedor y el modelo`, () => {
      const d = motivoDelProveedor(error, { provider: 'glm', model: 'z-ai/glm-5.3-flash' });
      expect(d.message).toContain('glm');
      expect(d.message).toContain('z-ai/glm-5.3-flash');
    });
  }

  it('sin el dato, el mensaje queda como estaba: el nombre es opcional', () => {
    // Hay call sites que solo tienen el error —el configurador es uno— y tienen
    // que seguir funcionando. Adivinar el proveedor ahí sería peor que callarse:
    // un nombre equivocado manda a revisar la cuenta que no falló.
    const d = motivoDelProveedor(new Error('insufficient balance'));
    expect(d.message).toContain('sin saldo');
    expect(d.message).not.toContain('El que falló fue');
  });

  it('con proveedor y sin modelo, nombra solo el proveedor', () => {
    const d = motivoDelProveedor(new Error('insufficient balance'), { provider: 'glm' });
    expect(d.message).toContain('El que falló fue glm.');
  });

  it('no cambia el motivo ni si conviene reintentar', () => {
    // El nombre es información, no una decisión: si cambiara el motivo, un
    // mensaje más claro cambiaría el código HTTP y eso ya es otra cosa.
    const sin = motivoDelProveedor(new Error('insufficient balance'));
    const con = motivoDelProveedor(new Error('insufficient balance'), { provider: 'glm' });
    expect(con.motivo).toBe(sin.motivo);
    expect(con.reintentable).toBe(sin.reintentable);
  });

  it('no publica la llave aunque venga en el error del proveedor', () => {
    const error = new Error('insufficient balance for key nvapi-secretoquenodebesalir');
    const d = motivoDelProveedor(error, { provider: 'glm', model: 'z-ai/glm-5.3' });
    expect(d.message).not.toContain('nvapi-secretoquenodebesalir');
  });
});
