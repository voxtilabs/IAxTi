import { describe, expect, it } from 'vitest';
import { motivoDelProveedor } from '../application/motivo-del-proveedor';
import { FalloDeHerramienta, FalloDelProveedor, esDelProveedor } from '../application/fallo-del-proveedor';

/**
 * Por qué NO contestó el proveedor (#402).
 *
 * Las respuestas de abajo son las REALES, no inventadas: la de Gemini sin
 * saldo se capturó el 21-09 pegándole a la API con la llave de Lino.
 */
describe('el motivo del proveedor', () => {
  it('sin saldo NO es reintentable, y lo dice sin la URL del proveedor', () => {
    // Marcado como del proveedor (#684): desde ese arreglo solo se clasifica lo
    // que vino de allá, y todas las respuestas de esta suite son suyas de verdad
    // —capturadas pegándole a la API—. Lo que cambió no es qué se reconoce, sino
    // que ya no se reconoce en errores que no son suyos.
    const d = motivoDelProveedor(
      FalloDelProveedor.de({
        statusCode: 402,
        message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects',
      }),
    );
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
    const cuota = motivoDelProveedor(
      FalloDelProveedor.de({ statusCode: 429, message: 'RESOURCE_EXHAUSTED: rate limit exceeded' }),
    );
    expect(cuota.motivo).toBe('cuota_agotada');
    expect(cuota.reintentable).toBe(true);

    const saldo = motivoDelProveedor(
      FalloDelProveedor.de({ statusCode: 402, message: 'RESOURCE_EXHAUSTED: prepayment credits are depleted' }),
    );
    expect(saldo.motivo).toBe('sin_saldo');
    expect(saldo.reintentable).toBe(false);
  });

  it('llave inválida o vencida', () => {
    for (const e of [
      { statusCode: 401, message: 'Invalid authentication credentials' },
      { statusCode: 403, message: 'permission denied' },
      { message: 'API key not valid. Please pass a valid API key.' },
    ]) {
      const d = motivoDelProveedor(FalloDelProveedor.de(e));
      expect(d.motivo, JSON.stringify(e)).toBe('llave_invalida');
      expect(d.reintentable).toBe(false);
    }
  });

  it('modelo que ya no existe manda a cambiarlo, no a reintentar', () => {
    const d = motivoDelProveedor(FalloDelProveedor.de({ statusCode: 404, message: 'models/gemini-1.0-pro is not found' }));
    expect(d.motivo).toBe('modelo_no_disponible');
    expect(d.reintentable).toBe(false);
    expect(d.message).toMatch(/configuración del asistente/);
  });

  it('el estado anidado también cuenta', () => {
    // Algunos SDK lo dejan en `response` o en `cause`.
    expect(motivoDelProveedor(FalloDelProveedor.de({ response: { status: 429 }, message: 'x' })).motivo).toBe(
      'cuota_agotada',
    );
    expect(motivoDelProveedor(FalloDelProveedor.de({ cause: { statusCode: 401 }, message: 'x' })).motivo).toBe(
      'llave_invalida',
    );
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
    // Lo lanza `languageModel`, DENTRO del puerto del modelo, así que llega
    // marcado como del proveedor — y esa clasificación es la correcta: no hay con
    // qué hablarle.
    const d = motivoDelProveedor(
      FalloDelProveedor.de(
        new Error('El proveedor google no tiene llave configurada (GOOGLE_GENERATIVE_AI_API_KEY).'),
      ),
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
      const d = motivoDelProveedor(FalloDelProveedor.de(error), { provider: 'glm', model: 'z-ai/glm-5.3-flash' });
      expect(d.message).toContain('glm');
      expect(d.message).toContain('z-ai/glm-5.3-flash');
    });
  }

  it('sin el dato, el mensaje queda como estaba: el nombre es opcional', () => {
    // Hay call sites que solo tienen el error —el configurador es uno— y tienen
    // que seguir funcionando. Adivinar el proveedor ahí sería peor que callarse:
    // un nombre equivocado manda a revisar la cuenta que no falló.
    const d = motivoDelProveedor(FalloDelProveedor.de(new Error('insufficient balance')));
    expect(d.message).toContain('sin saldo');
    expect(d.message).not.toContain('El que falló fue');
  });

  it('con proveedor y sin modelo, nombra solo el proveedor', () => {
    const d = motivoDelProveedor(FalloDelProveedor.de(new Error('insufficient balance')), { provider: 'glm' });
    expect(d.message).toContain('El que falló fue glm.');
  });

  it('no cambia el motivo ni si conviene reintentar', () => {
    // El nombre es información, no una decisión: si cambiara el motivo, un
    // mensaje más claro cambiaría el código HTTP y eso ya es otra cosa.
    const sin = motivoDelProveedor(FalloDelProveedor.de(new Error('insufficient balance')));
    const con = motivoDelProveedor(FalloDelProveedor.de(new Error('insufficient balance')), { provider: 'glm' });
    expect(con.motivo).toBe(sin.motivo);
    expect(con.reintentable).toBe(sin.reintentable);
  });

  it('no publica la llave aunque venga en el error del proveedor', () => {
    const error = new Error('insufficient balance for key nvapi-secretoquenodebesalir');
    const d = motivoDelProveedor(FalloDelProveedor.de(error), { provider: 'glm', model: 'z-ai/glm-5.3' });
    expect(d.message).not.toContain('nvapi-secretoquenodebesalir');
  });
});

/**
 * De quién es el error (#684).
 *
 * Éste es el defecto que tuvo a Lino revisando su cuenta de NVIDIA de madrugada
 * mientras la llave contestaba 200: `motivoDelProveedor` traduce el error DEL
 * PROVEEDOR y se usaba como clasificador de errores en general, comparando
 * palabras. Estas ocho entradas son todas NUESTRAS, y esto decían:
 *
 *   No tienes permiso para billing.read    -> «tu proveedor se quedó sin saldo»
 *   permission denied: crm.contacts.update -> «el proveedor rechazó la llave»
 *   No encontramos ese contacto. (404)     -> «el modelo ya no está disponible»
 *   IA_QUOTA_EXHAUSTED (nuestro tope)      -> «cuota del proveedor»
 *
 * Con instrucciones concretas encima —«carga crédito en su panel»—, o sea
 * mandando a arreglar una cuenta sana mientras el problema real quedaba
 * invisible. Un error sin explicar es mejor que uno explicado al revés.
 */
describe('solo se clasifica lo que vino del proveedor (#684)', () => {
  const nuestros: Array<[string, unknown]> = [
    ['un permiso de un módulo que se llama billing', new Error('No tienes permiso para billing.read')],
    ['una tool del catálogo', new Error('La herramienta BillingController_billing falló')],
    ['una ruta nuestra', Object.assign(new Error('GET /v1/billing devolvió 403'), { status: 403 })],
    ['autorización denegada', new Error('permission denied: crm.contacts.update')],
    ['el scope de una API key nuestra', new Error('La API key no tiene el scope apikeys.manage')],
    ['un contacto que no existe', Object.assign(new Error('No encontramos ese contacto.'), { status: 404 })],
    ['nuestro propio tope de IA', new Error('IA_QUOTA_EXHAUSTED: Se agotó la cuota de IA de este mes.')],
    ['nuestro propio 429', Object.assign(new Error('Demasiadas solicitudes seguidas.'), { status: 429 })],
  ];

  for (const [nombre, error] of nuestros) {
    it(`${nombre}: NO se reporta como problema del proveedor`, () => {
      const d = motivoDelProveedor(error);
      expect(d.motivo).toBe('desconocido');
      // Y sobre todo: nada de instrucciones sobre una cuenta que está sana.
      expect(d.message).not.toMatch(/saldo|crédito|credito|llave|recarga/i);
    });
  }

  it('la palabra billing a secas ya no alcanza, ni con la marca puesta', () => {
    // Es un módulo, una ruta y un permiso nuestros, y está en las 195
    // herramientas del agente general. Que un proveedor la use en una frase suya
    // es otra cosa, y para eso está el caso de abajo.
    const d = motivoDelProveedor(FalloDelProveedor.de(new Error('module billing is enabled')), { provider: 'glm' });
    expect(d.motivo).not.toBe('sin_saldo');
  });

  it('pero la frase de un proveedor de verdad sí', () => {
    const d = motivoDelProveedor(
      FalloDelProveedor.de(
        Object.assign(new Error('You exceeded your current quota, please check your plan and billing details.'), {
          status: 429,
        }),
      ),
      { provider: 'glm' },
    );
    expect(d.motivo).toBe('sin_saldo');
    expect(d.reintentable).toBe(false);
  });

  it('lo del proveedor se sigue nombrando igual que antes: esto no vuelve al genérico', () => {
    // #402 existió para sacar estos fallos del «algo falló de nuestro lado».
    // Arreglar #684 no puede deshacer eso.
    const casos: Array<[string, unknown, string]> = [
      ['sin saldo', new Error('Your prepayment credits are depleted.'), 'sin_saldo'],
      ['llave', Object.assign(new Error('invalid api key'), { status: 401 }), 'llave_invalida'],
      ['modelo', Object.assign(new Error('model not found'), { status: 404 }), 'modelo_no_disponible'],
      ['cuota', Object.assign(new Error('rate limit exceeded'), { status: 429 }), 'cuota_agotada'],
    ];
    for (const [, error, esperado] of casos) {
      expect(motivoDelProveedor(FalloDelProveedor.de(error)).motivo).toBe(esperado);
    }
  });

  it('un error de herramienta NO se marca como del proveedor aunque salga por el mismo await', () => {
    // La trampa del SDK: ejecuta las tools dentro de la llamada al modelo, así
    // que este error sale por donde saldría uno del proveedor. Sin distinguirlos,
    // envolver ahí marcaría como «del proveedor» justo los errores de este issue.
    const deTool = new FalloDeHerramienta('BillingController_billing', new Error('403 billing.read'));
    expect(esDelProveedor(deTool)).toBe(false);
    expect(motivoDelProveedor(deTool).motivo).toBe('desconocido');
  });

  it('quien lee de la base puede afirmarlo, y si no consta no se afirma', () => {
    // En `agent_executions` el error es texto y la marca no sobrevive: la fila
    // guarda de quién fue. NULL es «no se sabe», y no saberlo también impide
    // afirmar — por eso `false` y `undefined` llevan al mismo lugar prudente.
    const texto = new Error('Your prepayment credits are depleted.');
    expect(motivoDelProveedor(texto, { delProveedor: true }).motivo).toBe('sin_saldo');
    expect(motivoDelProveedor(texto, { delProveedor: false }).motivo).toBe('desconocido');
    expect(motivoDelProveedor(texto).motivo).toBe('desconocido');
  });
});
