import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Provider } from '../domain/config';

// El puerto de modelos (#47): Vercel AI SDK debajo, y una interfaz chica
// arriba para que el runtime se pruebe sin red. Las llaves SIEMPRE por
// entorno y SIEMPRE tier pago (§40: el gratis entrena con datos de
// clientes) — sin llave, el proveedor simplemente no está disponible.

export interface GenerateArgs {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
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
      const res = await generateText({
        model: languageModel(provider, model),
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens ?? 1024,
      });
      return {
        text: res.text,
        tokensIn: res.usage.inputTokens ?? 0,
        tokensOut: res.usage.outputTokens ?? 0,
      };
    },
  };
}

export type ModelPortFactory = (provider: Provider, model: string) => ModelPort;
