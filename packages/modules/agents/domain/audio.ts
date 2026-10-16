import { proveedorPermitidoParaTarea } from './config';

/** Mismo límite que los audios del canal (16 MiB), menor que los 25 MB de OpenAI. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const FORMATOS: Record<string, readonly string[]> = {
  openai: ['audio/flac', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm'],
  google: ['audio/flac', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/aiff'],
};

export class AudioNoAdmitido extends Error {
  constructor(message: string) { super(message); this.name = 'AudioNoAdmitido'; }
}

/** Los identificadores de chat no se convierten en modelos de audio. */
export function modeloPuedeTranscribir(provider: string, model: string): boolean {
  return provider === 'google' ? model.startsWith('gemini-')
    : provider === 'openai' && /^(whisper-1|gpt-transcribe|gpt-4o(?:-mini)?-transcribe(?:-\d{4}-\d{2}-\d{2})?)$/.test(model);
}

export function validarAudio(provider: string, audio: { bytes: Uint8Array; contentType: string }): string {
  if (!proveedorPermitidoParaTarea(provider, 'transcribir')) {
    throw new AudioNoAdmitido(`El puerto de ${provider} no tiene capacidad de transcribir audio.`);
  }
  if (audio.bytes.byteLength === 0 || audio.bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new AudioNoAdmitido('El audio debe tener contenido y no superar 16 MiB.');
  }
  const tipo = audio.contentType.split(';')[0].trim().toLowerCase();
  if (!FORMATOS[provider]?.includes(tipo)) {
    throw new AudioNoAdmitido(`El formato de audio no es compatible con ${provider}; no se envió al proveedor.`);
  }
  // Normalizar alias y quitar parámetros (p. ej. audio/ogg; codecs=opus).
  return ({ 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/m4a': 'audio/mp4', 'audio/x-m4a': 'audio/mp4' } as Record<string, string>)[tipo] ?? tipo;
}

export interface ResultadoDeTranscripcion {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  truncada?: boolean;
  seconds?: number;
}

/** Solo métricas numéricas conocidas; nunca conservar el cuerpo crudo del proveedor. */
export function usoDeAudioOpenAi(model: string, usage: unknown): Omit<ResultadoDeTranscripcion, 'text'> {
  const u = usage as Record<string, unknown> | undefined;
  const numero = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  const tokensIn = u?.type === 'tokens' ? numero(u.input_tokens) : null;
  const tokensOut = u?.type === 'tokens' ? numero(u.output_tokens) : null;
  // Fuente: developers.openai.com/api/docs/pricing, «Transcription models»,
  // consultada el 16-10-2026. USD / millón de tokens de transcripción (no chat).
  const tarifas: Record<string, { in: number; out: number }> = {
    'gpt-4o-mini-transcribe': { in: 1.25, out: 5 },
    'gpt-4o-transcribe': { in: 2.5, out: 10 },
  };
  const tarifa = tarifas[model];
  const seconds = u?.type === 'duration' ? numero(u.seconds) : null;
  const costUsd = tarifa && tokensIn !== null && tokensOut !== null
    ? Number(((tokensIn * tarifa.in + tokensOut * tarifa.out) / 1_000_000).toFixed(6))
    : model === 'whisper-1' && seconds !== null
      ? Number((seconds / 60 * 0.006).toFixed(6))
      : null;
  return { tokensIn, tokensOut, costUsd, ...(seconds !== null ? { seconds } : {}) };
}
