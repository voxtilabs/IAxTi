import { embedMany, generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// Embeddings (#51): puerto chico e inyectable — los tests no tocan la red
// y sin llave el módulo avisa en vez de adivinar. SIEMPRE tier pago (§40).

export interface EmbedPort {
  /** Devuelve un vector de 768 dimensiones por texto, en el mismo orden. */
  embed(texts: string[]): Promise<number[][]>;
}

export function embeddingsAvailable(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

export function googleEmbedPort(model = 'text-embedding-004'): EmbedPort {
  return {
    async embed(texts) {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) {
        throw new Error('Falta GOOGLE_GENERATIVE_AI_API_KEY para indexar conocimiento.');
      }
      const google = createGoogleGenerativeAI({ apiKey });
      const res = await embedMany({
        model: google.textEmbeddingModel(model),
        values: texts,
      });
      return res.embeddings;
    },
  };
}

/** PDFs (#51): Gemini multimodal extrae el texto — mismo patrón que la
 *  transcripción de audio (#48), sin dependencias de parseo. */
export interface PdfTextPort {
  extract(pdf: { bytes: Uint8Array }): Promise<string>;
}

export function geminiPdfTextPort(model = 'gemini-flash-latest'): PdfTextPort {
  return {
    async extract(pdf) {
      const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) throw new Error('Falta GOOGLE_GENERATIVE_AI_API_KEY para leer PDFs.');
      const google = createGoogleGenerativeAI({ apiKey });
      const res = await generateText({
        model: google(model),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', data: pdf.bytes, mediaType: 'application/pdf' },
              {
                type: 'text',
                text: 'Extrae TODO el texto de este documento tal cual, sin comentarios ni resúmenes.',
              },
            ],
          },
        ],
        maxOutputTokens: 8192,
      });
      return res.text.trim();
    },
  };
}

/** URLs: fetch + limpieza. Inyectable para tests. */
export interface UrlTextPort {
  fetch(url: string): Promise<string>;
}
