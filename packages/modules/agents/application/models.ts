import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { enteroDeEntorno, textoDeEntorno } from '@iaxti/core';
import { DEFAULT_TASK_MODELS, DEFAULT_TASK_OUTPUT_TOKENS, type Esfuerzo, type Provider, type TaskModel } from '../domain/config';
import { AudioNoAdmitido, modeloPuedeTranscribir, validarAudio, usoDeAudioOpenAi, type ResultadoDeTranscripcion } from '../domain/audio';
import { FalloDeHerramienta, FalloDelProveedor, esDeHerramienta } from './fallo-del-proveedor';

// El puerto de modelos (#47): Vercel AI SDK debajo, y una interfaz chica
// arriba para que el runtime se pruebe sin red. Las llaves SIEMPRE por
// entorno y SIEMPRE tier pago (§40: el gratis entrena con datos de
// clientes) — sin llave, el proveedor simplemente no está disponible.

/**
 * Una herramienta ofrecida al modelo (#240). El puerto no sabe de zod ni del
 * SDK: recibe el esquema de argumentos como JSON Schema y una función que
 * ejecuta. Quién puede ejecutarla, y si se le permite, lo decide
 * `ejecutarHerramienta` — acá solo se conecta el cable.
 */
export interface HerramientaExpuesta {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  ejecutar: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface GenerateArgs {
  system?: string;
  prompt: string;
  /**
   * Una CONVERSACIÓN en vez de un prompt suelto (#493).
   *
   * El Agente General necesita el hilo: sin los turnos anteriores, "sí,
   * hazlo" no significa nada. Cuando vienen, manda esto y `prompt` se
   * ignora — sigue siendo obligatorio en el tipo porque todo lo demás del
   * producto lo usa, y volverlo opcional obligaría a tocar siete llamadas
   * que están bien.
   */
  mensajes?: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens?: number;
  /**
   * Cuánto se espera al proveedor antes de cortar (#688).
   *
   * Sin esto no había ningún límite, en ninguna capa, y el 28/09 NVIDIA se puso
   * a encolar: `curl` pelado con «di hola», sin herramientas, tardó 139 s y
   * 178 s —la misma llamada que la noche anterior tardaba 2 s—. El panel se
   * quedaba en «Buscando entre sus herramientas…» para siempre y el reporte fue
   * «es como que no hay IA conectada».
   *
   * Que el proveedor esté lento no es nuestro. Que se vea idéntico a estar roto,
   * sí. Y mientras tanto la petición retiene una conexión del pool.
   */
  esperaMaximaMs?: number;
  /**
   * Cuánto piensa antes de escribir (#874). Sin valor, el defecto del
   * proveedor. Ver `Esfuerzo` en `domain/config.ts` para lo medido.
   */
  esfuerzo?: Esfuerzo;
  /**
   * Si vienen, el modelo puede pedirlas y la respuesta se arma con lo que
   * devuelvan. Sin herramientas, una sola llamada como siempre.
   */
  tools?: HerramientaExpuesta[];
  /**
   * Cuántas veces puede pedir herramientas antes de tener que contestar.
   *
   * Cuatro alcanzan para pedir dos datos y responder, y es el default de
   * todo el producto. El Agente General pide más: buscar entre 195
   * herramientas, mirar un módulo y preparar la acción son tres pasos antes
   * de escribir la primera palabra.
   */
  maxSteps?: number;
}

export interface GenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Qué herramientas pidió el modelo, en orden. Vacío si no pidió ninguna. */
  herramientasUsadas?: string[];
  /**
   * El modelo se quedó sin espacio de salida: la respuesta viene CORTADA.
   *
   * Importa más de lo que parece con los modelos que razonan: los tokens de
   * pensar se descuentan de la salida. Una sugerencia de tres líneas gastó
   * 665 de los 1024 disponibles en la primera corrida real — o sea que una
   * conversación larga corta.
   *
   * Y una respuesta cortada es JSON inválido, que sin esto terminaba en la
   * bandeja como texto para mandarle al cliente.
   */
  truncada?: boolean;
}

export interface ModelPort {
  generate(args: GenerateArgs): Promise<GenerateResult>;
}

export const ENV_KEYS: Record<Provider, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  glm: 'GLM_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function providerAvailable(provider: Provider): boolean {
  return Boolean(process.env[ENV_KEYS[provider]]?.trim());
}

function languageModel(provider: Provider, model: string): LanguageModel {
  const apiKey = process.env[ENV_KEYS[provider]];
  if (!apiKey) {
    throw new Error(
      `El proveedor ${provider} no tiene llave configurada (${ENV_KEYS[provider]}). ` +
        'Recuerda: tier pago donde pasan datos de clientes — producción siempre ' +
        '(ADR-0011, enmienda del 21-09).',
    );
  }
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'glm':
      // GLM servido por el catálogo de NVIDIA (ADR-0025 §7): la llave es
      // `nvapi-` y el endpoint es compatible OpenAI. Tool-calling y
      // streaming verificados el 2026-09-25 con `z-ai/glm-5.3`. Quien use
      // Zhipu directo pone su base por GLM_API_BASE.
      return createOpenAICompatible({
        name: 'glm',
        apiKey,
        // Vacía dejaba `baseURL: ''` y el SDK apuntaba a la API de OpenAI (#575).
        baseURL: textoDeEntorno('GLM_API_BASE', 'https://integrate.api.nvidia.com/v1'),
      })(model);
    case 'openai':
      /**
       * Por `@ai-sdk/openai` y NO por el adaptador compatible (#870).
       *
       * #842 lo había puesto por el compatible, con este argumento: «el de
       * OpenAI sabe de cosas suyas —la Responses API, los parámetros de
       * razonamiento— y nada de eso lo usa el producto; lo que IAxTi pide son
       * `/chat/completions` con herramientas, que es lo que este adaptador
       * habla, y es la misma pieza que ya sirve GLM. Agregar una dependencia
       * para lo mismo sería una segunda forma de hacer una cosa».
       *
       * Era razonable y era falso, y nadie lo midió contra la cuenta. La
       * familia `gpt-5` razona, y DOS de esos «parámetros suyos» resultaron
       * ser justo lo que el producto usa en cada llamada.
       *
       * El adaptador compatible manda `/chat/completions` con `max_tokens`, y
       * OpenAI contesta:
       *
       *     400 · Unsupported parameter: 'max_tokens' is not supported with
       *           this model. Use 'max_completion_tokens' instead.
       *
       * O sea: con el compatible, CADA llamada a gpt-5 muere en 400. Medido el
       * 12-10 dentro del contenedor, con la llave real, 1451 ms para
       * `gpt-5-mini` y 227 ms para `gpt-5`.
       *
       * Y el proveedor oficial no arregla eso cambiando el nombre del campo:
       * va por la **Responses API** (`/v1/responses`), donde el tope se llama
       * `max_output_tokens`. Tres nombres para el mismo concepto, uno por
       * camino, y la Responses API era la otra «cosa suya» que el comentario
       * de #842 dio por irrelevante.
       *
       * Verificado por el puerto, dentro del contenedor, el 12-10:
       * `gpt-5-mini` 6,3 s con una sugerencia correcta, `gpt-5` 3,6 s, y el
       * Agente General 15,2 s pidiendo tres herramientas y sin afirmar lo que
       * no sabía.
       *
       * Lo que esto enseña y vale más que el arreglo: las pruebas de #842 y la
       * medición de latencia de #863 pasaron las dos por `curl` armado a mano
       * —con el parámetro correcto— y ninguna por el puerto del producto.
       * «Probé el proveedor» y «probé el producto contra el proveedor» son
       * afirmaciones distintas, y solo la segunda dice algo.
       *
       * `OPENAI_API_BASE` existe para un proxy o un gateway; sin eso, la API
       * de OpenAI directo.
       */
      return createOpenAI({
        apiKey,
        baseURL: textoDeEntorno('OPENAI_API_BASE', 'https://api.openai.com/v1'),
      })(model);
  }
}

/**
 * El dial de razonamiento, traducido al idioma de cada proveedor (#874).
 *
 * Los cuatro tienen un equivalente y ninguno lo llama igual. Se mapea SOLO
 * donde está medido que el proveedor lo honra, porque un dial que se manda y
 * se ignora es peor que no tenerlo: se cree configurado y no hace nada.
 *
 *  - **openai** → `reasoningEffort`. Medido el 12-10: entre 4 y 8 veces más
 *    rápido, y en el despacho de herramientas también más preciso.
 *  - **glm** (NVIDIA) → NO se mapea. Acepta `reasoning_effort` sin error y no
 *    lo honra: medido una vez cada uno, con `low` razonó MÁS (99 tokens
 *    contra 45) y tardó más (4475 ms contra 1775). No hay evidencia de que
 *    haga nada, así que mandarlo sería declarar un dial que no existe.
 *  - **google** → tiene `thinkingConfig.thinkingBudget` y **anthropic** tiene
 *    `thinking.budgetTokens`, los dos en tokens y no en niveles. No se mapean
 *    todavía porque no hay cuenta con saldo para medirlos, y en anthropic
 *    además habilitar `thinking` donde hoy está apagado es un cambio de
 *    comportamiento, no una calibración. Cuando haya con qué medir, acá.
 *
 * Dónde se ve lo que de verdad viaja: `el-cuerpo-que-sale-al-proveedor.test.ts`.
 */
function dialDelProveedor(
  provider: Provider,
  esfuerzo: Esfuerzo | undefined,
): { openai: { reasoningEffort: string } } | undefined {
  if (!esfuerzo || provider !== 'openai') return undefined;
  const equivalente: Record<Esfuerzo, string> = {
    minimo: 'minimal',
    bajo: 'low',
    medio: 'medium',
    alto: 'high',
  };
  return { openai: { reasoningEffort: equivalente[esfuerzo] } };
}

/** El ModelPort real sobre el AI SDK. Los tests inyectan uno falso. */
export function aiSdkModelPort(provider: Provider, model: string): ModelPort {
  return {
    async generate(args) {
      const usadas: string[] = [];
      const herramientas = Object.fromEntries(
        (args.tools ?? []).map((h) => [
          h.name,
          tool({
            description: h.description,
            inputSchema: jsonSchema(h.parameters as Parameters<typeof jsonSchema>[0]),
            execute: async (entrada: unknown) => {
              usadas.push(h.name);
              // Marcado como NUESTRO (#684). El SDK ejecuta las tools dentro de
              // la llamada al modelo, así que este error sale por el mismo
              // `await` que uno del proveedor. Sin la marca, envolver abajo
              // convertiría «no tienes permiso para billing.read» en «tu
              // proveedor se quedó sin saldo», que es exactamente lo que pasó.
              try {
                return await h.ejecutar((entrada ?? {}) as Record<string, unknown>);
              } catch (err) {
                throw new FalloDeHerramienta(h.name, err);
              }
            },
          }),
        ]),
      );
      const conHerramientas = Object.keys(herramientas).length > 0;

      // La única puerta al proveedor, y por eso el único lugar donde se pone la
      // marca (#684). Lo que no pasa por acá no es del proveedor y no se
      // clasifica como suyo. `languageModel` también entra: su «no tiene llave
      // configurada» ES del proveedor —no hay con qué hablarle— y esa
      // clasificación es la correcta.
      // El reloj (#688). `AbortSignal.timeout` corta la petición de verdad —no
      // solo deja de esperarla— que es lo que libera la conexión del pool.
      const espera = args.esperaMaximaMs ?? ESPERA_MAXIMA_MS;
      const res = await conLaMarcaDelProveedor(() =>
        generateText({
        abortSignal: AbortSignal.timeout(espera),
        model: languageModel(provider, model),
        ...(dialDelProveedor(provider, args.esfuerzo)
          ? { providerOptions: dialDelProveedor(provider, args.esfuerzo) }
          : {}),
        system: args.system,
        // Un hilo si lo hay; si no, el prompt suelto de siempre.
        ...(args.mensajes?.length ? { messages: args.mensajes } : { prompt: args.prompt }),
        maxOutputTokens: args.maxOutputTokens ?? 1024,
        ...(conHerramientas
          ? {
              tools: herramientas,
              // El tope es del bucle, no del modelo: sin él, un modelo que
              // se obsesiona con una herramienta pide lo mismo para
              // siempre y la conversación se queda esperando. Cuatro pasos
              // alcanzan para pedir dos datos y responder.
              stopWhen: stepCountIs(args.maxSteps ?? 4),
            }
          : {}),
        }),
      );
      return {
        text: res.text,
        // Con herramientas hay varios pasos: `usage` ya viene sumado, pero
        // si el SDK no lo informa, la suma de los pasos es la verdad.
        tokensIn: res.usage.inputTokens ?? res.steps?.reduce((a, s) => a + (s.usage.inputTokens ?? 0), 0) ?? 0,
        tokensOut: res.usage.outputTokens ?? res.steps?.reduce((a, s) => a + (s.usage.outputTokens ?? 0), 0) ?? 0,
        ...(usadas.length ? { herramientasUsadas: usadas } : {}),
        // `length` es la señal del proveedor de que llegó al tope. Es más
        // confiable que adivinar mirando el texto.
        ...(res.finishReason === 'length' ? { truncada: true } : {}),
      };
    },
  };
}

/**
 * Cuánto se le espera al proveedor, por omisión (#688).
 *
 * Un minuto para una pregunta del panel es generoso: lo normal son segundos. Lo
 * que no puede pasar es lo de hoy —tres minutos de spinner mudo—, porque nadie
 * espera tres minutos: se cierra el panel y se concluye que el producto está
 * roto.
 *
 * Por variable, porque no todas las tareas son iguales: una evaluación con
 * muchos pasos no es una pregunta del panel, y quien la corre sí puede esperar.
 */
export const ESPERA_MAXIMA_MS = enteroDeEntorno('IA_ESPERA_MAXIMA_MS', 60_000);

/**
 * Corre algo contra el proveedor y marca lo que salga mal como suyo (#684).
 *
 * Un fallo de herramienta pasa tal cual: ya viene marcado como nuestro desde el
 * `execute`, y volver a envolverlo lo convertiría en lo contrario de lo que es.
 */
async function conLaMarcaDelProveedor<T>(hacer: () => PromiseLike<T>): Promise<T> {
  try {
    return await hacer();
  } catch (err) {
    if (esDeHerramienta(err)) throw err;
    throw FalloDelProveedor.de(err);
  }
}

export type ModelPortFactory = (provider: Provider, model: string) => ModelPort;

/** Transcripción de audio (#48/#864), con uso real y puerto inyectable. */
export interface TranscribePort {
  proveedor: string;
  modelo: string;
  transcribe(audio: { bytes: Uint8Array; contentType: string; esperaMaximaMs?: number }): Promise<ResultadoDeTranscripcion>;
}

/** Puerto de AUDIO. No se manda ningún archivo a chat/completions o Responses. */
export function aiSdkTranscriber(elegido: TaskModel = DEFAULT_TASK_MODELS.transcribir): TranscribePort {
  const { provider, model } = elegido;
  return {
    proveedor: provider,
    modelo: model,
    async transcribe(audio) {
      const mediaType = validarAudio(provider, audio);
      if (!modeloPuedeTranscribir(provider, model)) throw new AudioNoAdmitido('El modelo configurado no tiene capacidad de transcripción en el puerto de audio. Revisa el modelo de la tarea.');
      if (!providerAvailable(provider)) throw new AudioNoAdmitido(`No hay credencial configurada para transcribir con ${provider}. Revisa ${ENV_KEYS[provider]}.`);
      const abortSignal = AbortSignal.timeout(audio.esperaMaximaMs ?? ESPERA_MAXIMA_MS);
      if (provider === 'openai') {
        // doGenerate conserva usage y MIME. El helper genérico transcribe del SDK
        // instalado descarta usage; tampoco permite declarar el MIME del archivo.
        const apiKey = process.env[ENV_KEYS.openai]?.trim();
        if (!apiKey) throw new AudioNoAdmitido('No hay credencial configurada para transcribir con OpenAI.');
        const puerto = createOpenAI({ apiKey, baseURL: textoDeEntorno('OPENAI_API_BASE', 'https://api.openai.com/v1') }).transcription(model);
        const res = await conLaMarcaDelProveedor(() => puerto.doGenerate({
          audio: audio.bytes, mediaType, abortSignal,
          providerOptions: { openai: { language: 'es', responseFormat: 'json', timestampGranularities: [] } },
        }));
        return { text: res.text.trim(), ...usoDeAudioOpenAi(model, res.usage) };
      }
      // Google conserva su API multimodal; no pasa por el endpoint de chat de OpenAI.
      const res = await conLaMarcaDelProveedor(() => generateText({
        model: languageModel(provider, model),
        messages: [{ role: 'user', content: [
          { type: 'file', data: audio.bytes, mediaType },
          { type: 'text', text: 'Transcribe este audio al español tal cual se dice, sin comentarios.' },
        ] }],
        maxOutputTokens: DEFAULT_TASK_OUTPUT_TOKENS.transcribir,
        abortSignal,
        maxRetries: 0,
      }));
      return {
        text: res.text.trim(), tokensIn: res.usage.inputTokens ?? null,
        tokensOut: res.usage.outputTokens ?? null,
        // La tarifa de entrada de texto no es la de audio. Sin desglose/tarifa
        // verificada para el modelo Google elegido no se inventa un costo cero.
        costUsd: null, truncada: res.finishReason === 'length',
      };
    },
  };
}
