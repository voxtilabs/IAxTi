import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fuenteLimpia } from '@iaxti/core/testing';
import { aiSdkModelPort, transcriberPara } from '../application/models';
import { PROVIDERS, proveedorPermitidoParaTarea } from '../domain/config';

/**
 * Qué sale de verdad hacia el proveedor (#870).
 *
 * Lo que costó: #863 movió el proveedor por defecto a OpenAI y **cada llamada
 * moría en 400** — `Unsupported parameter: 'max_tokens' is not supported with
 * this model. Use 'max_completion_tokens' instead`. El adaptador compatible
 * declara el tope como `max_tokens` y la familia `gpt-5` exige el otro nombre.
 *
 * Y por qué no lo cazó nada: las pruebas de #842 y la medición de latencia que
 * justificó #863 se hicieron con `curl` armado a mano, mandando el parámetro
 * correcto porque es lo que dice la documentación. Ninguna pasó por el puerto
 * del producto. «Probé el proveedor» y «probé el producto contra el proveedor»
 * son afirmaciones distintas, y solo la segunda dice algo.
 *
 * Así que esta prueba mira lo único que no se puede fingir: el cuerpo HTTP.
 * Se intercepta `fetch`, que es por donde el SDK sale, y se lee el JSON.
 * Sin red, sin llave real, y no puede pasar por omisión — si el cuerpo no
 * llega, no hay nada que afirmar y la prueba se cae.
 */
const fetchOriginal = globalThis.fetch;
let cuerpos: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  cuerpos = [];
  process.env.OPENAI_API_KEY = 'llave-de-prueba';
  process.env.GLM_API_KEY = 'llave-de-prueba';
  globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
    const url = typeof entrada === 'string' ? entrada : String((entrada as Request)?.url ?? entrada);
    cuerpos.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    // La respuesta mínima que cada API sabe leer: lo que se prueba es la IDA.
    // OpenAI va por la Responses API y GLM por `/chat/completions`, así que la
    // forma de la vuelta es distinta y el doble tiene que respetar las dos.
    const cuerpo = url.includes('api.anthropic.com')
      ? {
          id: 'x',
          type: 'message',
          role: 'assistant',
          model: 'x',
          content: [{ type: 'text', text: 'listo' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 2 },
        }
      : url.includes('generativelanguage.googleapis.com')
      ? {
          candidates: [
            { content: { parts: [{ text: 'listo' }], role: 'model' }, finishReason: 'STOP', index: 0 },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
          modelVersion: 'x',
        }
      : url.includes('/responses')
      ? {
          id: 'x',
          object: 'response',
          created_at: 0,
          model: 'x',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'm',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'listo', annotations: [] }],
            },
          ],
          usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
        }
      : {
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'x',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'listo' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        };
    return new Response(JSON.stringify(cuerpo), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe('el cuerpo que el producto manda al proveedor (#870)', () => {
  it('a OpenAI va por la Responses API y el tope como max_output_tokens, nunca max_tokens', async () => {
    const r = await aiSdkModelPort('openai', 'gpt-5-mini').generate({
      system: 'Respondé corto.',
      prompt: 'hola',
      maxOutputTokens: 1234,
    });
    expect(r.text).toBe('listo');

    // Anti-vacuidad: si el fetch no se interceptó, no hay nada que mirar.
    expect(cuerpos).toHaveLength(1);
    const { url, body } = cuerpos[0];
    expect(url).toContain('api.openai.com');
    /**
     * La Responses API, que es justo una de «las cosas suyas» que el
     * comentario de #842 dio por irrelevantes: ahí el tope se llama
     * `max_output_tokens`. Por `/chat/completions` el adaptador compatible lo
     * mandaba como `max_tokens`, y OpenAI contestaba 400 en cada llamada
     * pidiendo `max_completion_tokens`. Los tres nombres son del mismo
     * concepto y solo uno sirve por cada camino.
     */
    expect(url).toContain('/responses');
    expect(body.max_output_tokens).toBe(1234);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('a GLM el tope va como max_tokens, que ahí es el correcto', async () => {
    // El adaptador compatible se queda para GLM: su endpoint en NVIDIA espera
    // este nombre, y está medido. El arreglo de #870 es para OpenAI, no un
    // cambio de criterio para todos.
    await aiSdkModelPort('glm', 'z-ai/glm-5.3-flash').generate({
      system: 'Respondé corto.',
      prompt: 'hola',
      maxOutputTokens: 777,
    });
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].url).toContain('nvidia.com');
    expect(cuerpos[0].body.max_tokens).toBe(777);
  });

  it('a Google el tope va como maxOutputTokens, en su propio formato', async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'llave-de-prueba';
    await aiSdkModelPort('google', 'gemini-flash-latest').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 555,
    });
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].url).toContain('generativelanguage.googleapis.com');
    // Gemini lo lleva anidado en `generationConfig`, no al ras del cuerpo.
    const gen = cuerpos[0].body.generationConfig as Record<string, unknown>;
    expect(gen?.maxOutputTokens).toBe(555);
  });

  it('a Anthropic el tope va como max_tokens, que ahí es el correcto', async () => {
    process.env.ANTHROPIC_API_KEY = 'llave-de-prueba';
    await aiSdkModelPort('anthropic', 'claude-haiku-4-5-20251001').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 333,
    });
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].url).toContain('api.anthropic.com');
    expect(cuerpos[0].body.max_tokens).toBe(333);
  });

  /**
   * La guarda de la lección, y la razón por la que este archivo existe.
   *
   * Lo que falló no fue el código: fue la FORMA de la evidencia. #842 declaró
   * openai verificado y #863 publicó una tabla de latencias que decidió el
   * proveedor por defecto del producto, y las dos midieron con `curl`. Cada
   * proveedor nuevo puede traer su propia particularidad —un nombre de campo,
   * una API distinta, un tope— y ninguna aparece si lo que se prueba es el
   * proveedor en vez del producto.
   *
   * Así que: todo proveedor que el producto pueda elegir tiene que tener acá
   * una corrida POR EL PUERTO que mire el cuerpo que sale. No comprueba que
   * ande —eso necesita la cuenta— pero sí que el producto le hable en su
   * idioma, que es lo que no se comprobaba.
   */
  it('todo proveedor de texto tiene una corrida por el puerto en este archivo', () => {
    const texto = fuenteLimpia(readFileSync(__filename, 'utf8'));
    const deTexto = PROVIDERS.filter((p) => proveedorPermitidoParaTarea(p, 'sugerir'));
    // Anti-vacuidad: si el filtro quedara vacío, el bucle no mediría nada.
    expect(deTexto.length).toBeGreaterThan(2);

    const faltan = deTexto.filter((p) => !new RegExp(`aiSdkModelPort\\('${p}'`).test(texto));
    expect(
      faltan,
      'Estos proveedores los puede elegir el producto y nadie comprobó qué cuerpo les manda. ' +
        'Es lo que dejó pasar #870: «probé el proveedor» no es «probé el producto contra el ' +
        `proveedor».\n  ${faltan.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * El dial de razonamiento viaja (#874), y esta es la prueba que faltaba.
   *
   * La primera versión del dial lo declaraba en `DEFAULT_TASK_MODELS` y lo
   * perdía en el merge de `iaSettings`: las dos ramas que arman la tarea
   * construyen el objeto de cero con solo `provider` y `model`. O sea
   * declarado en un lado y aplicado en ninguno —el defecto que llevamos una
   * semana sacando del repo— y escrito por mí. Lo cazó mirar el merge antes de
   * empujar; esto lo caza para siempre.
   */
  it('a OpenAI el dial de razonamiento viaja como reasoningEffort', async () => {
    await aiSdkModelPort('openai', 'gpt-5-mini').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 100,
      esfuerzo: 'minimo',
    });
    expect(cuerpos).toHaveLength(1);
    // El nombre del proveedor, no el nuestro: `minimo` → `minimal`.
    expect(cuerpos[0].body.reasoning).toMatchObject({ effort: 'minimal' });
  });

  it('sin dial no se manda nada: ausente no es «medio»', async () => {
    // Mandar un valor por defecto propio sería decidir por el proveedor algo
    // que no medimos. Sin valor, manda él.
    await aiSdkModelPort('openai', 'gpt-5-mini').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 100,
    });
    expect(cuerpos[0].body).not.toHaveProperty('reasoning');
  });

  it('a GLM el dial NO se manda, porque está medido que no lo honra', async () => {
    // NVIDIA acepta `reasoning_effort` sin error y no hace nada: medido el
    // 12-10, con `low` razonó MÁS (99 tokens contra 45) y tardó más (4475 ms
    // contra 1775). Mandarlo sería declarar un dial que no existe, que es
    // justo la familia de defectos que esto evita.
    await aiSdkModelPort('glm', 'z-ai/glm-5.3-flash').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 100,
      esfuerzo: 'minimo',
    });
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].body).not.toHaveProperty('reasoning_effort');
    expect(cuerpos[0].body).not.toHaveProperty('reasoning');
  });

  it('la transcripción a OpenAI va por la API DE AUDIO, multipart, con el archivo adentro (#864)', async () => {
    // Interceptor propio: el del beforeEach hace JSON.parse del cuerpo y una
    // petición multipart no es JSON — justamente lo que esta guarda cuida.
    const idas: Array<{ url: string; auth: string; body: unknown }> = [];
    globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
      const url = typeof entrada === 'string' ? entrada : String((entrada as Request)?.url ?? entrada);
      idas.push({
        url,
        auth: String((init?.headers as Record<string, string>)?.Authorization ?? ''),
        body: init?.body,
      });
      return new Response(JSON.stringify({ text: 'hola, quiero una hora' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const puerto = transcriberPara('openai', 'gpt-4o-mini-transcribe');
    const texto = await puerto.transcribe({ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/ogg' });
    expect(texto).toBe('hola, quiero una hora');

    expect(idas).toHaveLength(1);
    expect(idas[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(idas[0].auth).toBe('Bearer llave-de-prueba');
    const form = idas[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    const archivo = form.get('file') as File;
    // El nombre lleva la extensión del formato: la API lo reconoce por ahí,
    // y WhatsApp manda las notas de voz como ogg.
    expect(archivo.name).toBe('audio.ogg');
    expect(archivo.type).toBe('audio/ogg');
  });

  it('el modelo que se pide es el que viaja', async () => {
    await aiSdkModelPort('openai', 'gpt-5').generate({
      system: 'x',
      prompt: 'hola',
      maxOutputTokens: 100,
    });
    expect(cuerpos[0].body.model).toBe('gpt-5');
  });
});
