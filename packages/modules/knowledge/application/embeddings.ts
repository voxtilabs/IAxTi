import { embedMany, generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// Embeddings (#51, #502): puerto chico e inyectable — los tests no tocan la
// red y sin llave el módulo avisa en vez de adivinar. SIEMPRE tier pago (§40).

/**
 * Para qué se está embebiendo el texto.
 *
 * No es decoración: el modelo de NVIDIA es ASIMÉTRICO — le entra
 * `input_type` y devuelve vectores distintos para el mismo texto según el
 * rol (medido el 2026-09-25: coseno 0.57 entre `query` y `passage` de
 * "hola"). Embeber la pregunta como si fuera un pasaje no falla: contesta
 * peor y no avisa. Con el rol correcto, "¿a qué hora abren los sábados?"
 * le saca 0.430 contra 0.088 al pasaje equivocado; con el rol errado los
 * puntajes se aplastan a 0.414 contra 0.385 y el orden lo decide el azar.
 *
 * Por eso el parámetro es obligatorio: quien llame tiene que decir qué está
 * embebiendo, y el compilador no lo deja olvidarse.
 */
export type RolDelTexto = 'pasaje' | 'pregunta';

export const DIMENSIONES = 2048;

export interface EmbedPort {
  /** Un vector de `DIMENSIONES` por texto, en el mismo orden. */
  embed(texts: string[], rol: RolDelTexto): Promise<number[][]>;
}

export function embeddingsAvailable(): boolean {
  // La MISMA llave que GLM, con el mismo nombre: es la misma cuenta de NVIDIA
  // y el mismo `nvapi-`. Un segundo nombre para el mismo secreto es cómo
  // queda un despliegue a medio configurar sin que nada falle.
  return Boolean(process.env.GLM_API_KEY);
}

const INPUT_TYPE: Record<RolDelTexto, string> = {
  pasaje: 'passage',
  pregunta: 'query',
};

/**
 * Embeddings por el catálogo de NVIDIA (#502, ADR-0025 §7), el mismo que
 * sirve GLM: una sola llave `nvapi-` para todo el producto.
 *
 * Va por `fetch` y no por el proveedor compatible-OpenAI del AI SDK porque
 * ese no manda `input_type`, y sin `input_type` este modelo entrega el
 * vector equivocado sin protestar.
 *
 * Medido el 2026-09-25 con esta cuenta: de los siete modelos de embedding
 * que lista el catálogo, seis responden 404 («Not found for account») y
 * solo `nvidia/nemotron-3-embed-1b` está habilitado. Sus 2048 dimensiones
 * son fijas: pedir `dimensions: 1024` responde «dimensions must be one of
 * 2048», así que no hay forma de recortarlo para entrar en el límite de
 * 2000 del índice HNSW — de ahí `halfvec` en la migración 0002.
 */
export function nvidiaEmbedPort(model = 'nvidia/nemotron-3-embed-1b'): EmbedPort {
  return {
    async embed(texts, rol) {
      const apiKey = process.env.GLM_API_KEY;
      if (!apiKey) {
        throw new Error('Falta GLM_API_KEY para indexar conocimiento.');
      }
      if (texts.length === 0) return [];
      const base = process.env.GLM_API_BASE ?? 'https://integrate.api.nvidia.com/v1';
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts, input_type: INPUT_TYPE[rol] }),
      });
      if (!res.ok) {
        const detalle = await res.text().catch(() => '');
        throw new Error(
          `El proveedor de embeddings respondió ${res.status}. ${detalle.slice(0, 300)}`.trim(),
        );
      }
      const cuerpo = (await res.json()) as {
        data?: Array<{ embedding: number[]; index?: number }>;
      };
      const datos = cuerpo.data ?? [];
      if (datos.length !== texts.length) {
        throw new Error(
          `Pedimos ${texts.length} embeddings y llegaron ${datos.length}: no los podemos pegar a su texto.`,
        );
      }
      // El orden viene por `index` y no necesariamente en fila: si lo
      // asumimos, un pasaje queda con el vector de otro y el buscador
      // devuelve cualquier cosa sin fallar.
      const ordenados = datos.every((d) => typeof d.index === 'number')
        ? [...datos].sort((a, b) => a.index! - b.index!)
        : datos;
      for (const d of ordenados) {
        if (d.embedding.length !== DIMENSIONES) {
          throw new Error(
            `El modelo ${model} devolvió ${d.embedding.length} dimensiones y la tabla espera ${DIMENSIONES}.`,
          );
        }
      }
      return ordenados.map((d) => d.embedding);
    },
  };
}

/**
 * El puerto viejo (#51). Se queda para el negocio que pidió por escrito
 * quedarse en Gemini, y porque tirarlo no es parte de #502.
 *
 * `text-embedding-004` es simétrico: no tiene `input_type`, así que el rol
 * se recibe y se ignora a propósito. OJO: entrega 768 dimensiones, y desde
 * la migración 0002 la columna espera 2048 — quien lo use tiene que llevar
 * su propia tabla.
 */
export function googleEmbedPort(model = 'text-embedding-004'): EmbedPort {
  return {
    async embed(texts, _rol) {
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
