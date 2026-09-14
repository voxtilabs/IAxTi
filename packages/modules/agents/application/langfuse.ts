import { Langfuse } from 'langfuse';

// Langfuse (#47): trazas y prompts VERSIONADOS. Env-gated: sin llaves no
// traza (y los prompts caen al fallback configurado del agente) — jamás un
// prompt crítico hardcodeado en el código.

let cliente: Langfuse | null | undefined;

export function langfuse(): Langfuse | null {
  if (cliente !== undefined) return cliente;
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    cliente = null;
    return null;
  }
  cliente = new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
  });
  return cliente;
}

/** Prompt versionado; sin Langfuse (o si falla) devuelve null y el runtime
 *  usa el fallback configurado del agente. Cache simple en memoria. */
const promptCache = new Map<string, { compiled: string; at: number }>();

export async function getVersionedPrompt(
  name: string,
  version?: string,
): Promise<string | null> {
  const lf = langfuse();
  if (!lf) return null;
  const clave = `${name}@${version ?? 'latest'}`;
  const cacheado = promptCache.get(clave);
  if (cacheado && Date.now() - cacheado.at < 60_000) return cacheado.compiled;
  try {
    const prompt = await lf.getPrompt(name, version ? Number(version) : undefined);
    const compiled = prompt.prompt as unknown as string;
    if (typeof compiled !== 'string') return null;
    promptCache.set(clave, { compiled, at: Date.now() });
    return compiled;
  } catch {
    return null;
  }
}

export interface TraceInput {
  traceId: string;
  tenantId: string;
  task: string;
  provider: string;
  model: string;
  input: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

/** La generación con el MISMO trace_id del request. Mejor esfuerzo. */
export function traceGeneration(t: TraceInput): void {
  const lf = langfuse();
  if (!lf) return;
  try {
    const trace = lf.trace({ id: t.traceId, name: t.task, metadata: { tenantId: t.tenantId } });
    trace.generation({
      name: `${t.task}:${t.provider}:${t.model}`,
      model: t.model,
      input: t.input,
      output: t.output,
      usage: { input: t.tokensIn, output: t.tokensOut },
      metadata: { latencyMs: t.latencyMs, provider: t.provider },
    });
    void lf.flushAsync().catch(() => {});
  } catch {
    /* trazar jamás rompe la ejecución */
  }
}

/** Solo para tests. */
export function resetLangfuse(): void {
  cliente = undefined;
  promptCache.clear();
}
