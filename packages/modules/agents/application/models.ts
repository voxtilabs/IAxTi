import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Provider } from '../domain/config';

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

const ENV_KEYS: Record<Provider, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  glm: 'GLM_API_KEY',
};

export function providerAvailable(provider: Provider): boolean {
  return Boolean(process.env[ENV_KEYS[provider]]);
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
        baseURL: process.env.GLM_API_BASE ?? 'https://integrate.api.nvidia.com/v1',
      })(model);
  }
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
              return h.ejecutar((entrada ?? {}) as Record<string, unknown>);
            },
          }),
        ]),
      );
      const conHerramientas = Object.keys(herramientas).length > 0;

      const res = await generateText({
        model: languageModel(provider, model),
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
      });
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

export type ModelPortFactory = (provider: Provider, model: string) => ModelPort;

/** Transcripción de audio (#48): Gemini multimodal. Inyectable en tests. */
export interface TranscribePort {
  transcribe(audio: { bytes: Uint8Array; contentType: string }): Promise<string>;
}

export function aiSdkTranscriber(model = 'gemini-flash-latest'): TranscribePort {
  return {
    async transcribe(audio) {
      const res = await generateText({
        model: languageModel('google', model),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', data: audio.bytes, mediaType: audio.contentType },
              {
                type: 'text',
                text: 'Transcribe este audio al español tal cual se dice, sin comentarios.',
              },
            ],
          },
        ],
        maxOutputTokens: 2048,
      });
      return res.text.trim();
    },
  };
}
