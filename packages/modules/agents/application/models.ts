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
  maxOutputTokens?: number;
  /**
   * Si vienen, el modelo puede pedirlas y la respuesta se arma con lo que
   * devuelvan. Sin herramientas, una sola llamada como siempre.
   */
  tools?: HerramientaExpuesta[];
}

export interface GenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Qué herramientas pidió el modelo, en orden. Vacío si no pidió ninguna. */
  herramientasUsadas?: string[];
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
        'Recuerda: siempre tier pago — el gratis entrena con datos de clientes.',
    );
  }
  switch (provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'glm':
      // GLM (Zhipu) expone endpoint compatible OpenAI (ADR-0011 / #54).
      return createOpenAICompatible({
        name: 'glm',
        apiKey,
        baseURL: process.env.GLM_API_BASE ?? 'https://open.bigmodel.cn/api/paas/v4',
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
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens ?? 1024,
        ...(conHerramientas
          ? {
              tools: herramientas,
              // El tope es del bucle, no del modelo: sin él, un modelo que
              // se obsesiona con una herramienta pide lo mismo para
              // siempre y la conversación se queda esperando. Cuatro pasos
              // alcanzan para pedir dos datos y responder.
              stopWhen: stepCountIs(4),
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
      };
    },
  };
}

export type ModelPortFactory = (provider: Provider, model: string) => ModelPort;

/** Transcripción de audio (#48): Gemini multimodal. Inyectable en tests. */
export interface TranscribePort {
  transcribe(audio: { bytes: Uint8Array; contentType: string }): Promise<string>;
}

export function aiSdkTranscriber(model = 'gemini-2.5-flash'): TranscribePort {
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
