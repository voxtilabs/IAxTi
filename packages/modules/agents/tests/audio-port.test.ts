import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSdkTranscriber, providerAvailable } from '../application/models';
import { esDelProveedor } from '../application/fallo-del-proveedor';
import { MAX_AUDIO_BYTES, usoDeAudioOpenAi } from '../domain/audio';
import { DEFAULT_TASK_MODELS, PROVIDERS, TASKS, iaSettings, proveedorPermitidoParaTarea } from '../domain/config';
import { diagnosticarLaIa } from '../application/diagnostico-ia';
import { probarLaIa } from '../application/probar-la-ia';

import { audioSintetico } from './audio-fixture';
const respuesta = () => Response.json({ text: ' Texto sintético. ', usage: { type: 'tokens', input_tokens: 100, output_tokens: 20, total_tokens: 120, input_token_details: { audio_tokens: 100, text_tokens: 0 } } });
beforeEach(() => {
  for (const variable of ['OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY', 'GLM_API_KEY']) vi.stubEnv(variable, '');
  vi.stubEnv('OPENAI_API_KEY', 'llave-ficticia');
  vi.stubEnv('OPENAI_API_BASE', 'https://audio.invalid/v1');
  vi.stubGlobal('fetch', vi.fn(async () => respuesta()));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('audio por el puerto REAL del producto (#864), HTTP interceptado', () => {
  it('sin Google, OpenAI recibe multipart por /audio/transcriptions con MIME y bytes intactos', async () => {
    const bytes = audioSintetico();
    const resultado = await aiSdkTranscriber().transcribe({ bytes, contentType: 'audio/wav' });
    expect(providerAvailable('google')).toBe(false);
    expect(resultado).toEqual({ text: 'Texto sintético.', tokensIn: 100, tokensOut: 20, costUsd: 0.000225 });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://audio.invalid/v1/audio/transcriptions');
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('es');
    expect(form.get('response_format')).toBe('json');
    expect([...form.keys()].sort()).toEqual(['file', 'language', 'model', 'response_format', 'temperature']);
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav'); expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('OGG de WhatsApp conserva contenedor y elimina parámetro codecs del MIME', async () => {
    await aiSdkTranscriber().transcribe({ bytes: new Uint8Array([79,103,103,83]), contentType: 'audio/ogg; codecs=opus' });
    const file = (vi.mocked(fetch).mock.calls[0][1]!.body as FormData).get('file') as File;
    expect(file.name).toBe('audio.ogg'); expect(file.type).toBe('audio/ogg');
  });
  it.each(['audio/amr', 'audio/aac', 'text/plain'])('rechaza %s antes de llamar y sin reinterpretarlo como otro formato', async contentType => {
    await expect(aiSdkTranscriber().transcribe({ bytes: audioSintetico(), contentType })).rejects.toThrow('formato');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([0, MAX_AUDIO_BYTES + 1])('rechaza tamaño %s antes de llamar', async size => {
    await expect(aiSdkTranscriber().transcribe({ bytes: new Uint8Array(size), contentType: 'audio/ogg' })).rejects.toThrow('16 MiB');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['glm', 'anthropic'] as const)('%s no recibe un file part ni una llamada', async provider => {
    await expect(aiSdkTranscriber({ provider, model: 'texto' }).transcribe({ bytes: audioSintetico(), contentType: 'audio/wav' })).rejects.toThrow('capacidad');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('un modelo de chat no se convierte en uno de audio silenciosamente', async () => {
    await expect(aiSdkTranscriber({ provider: 'openai', model: 'gpt-5-mini' }).transcribe({ bytes: audioSintetico(), contentType: 'audio/wav' })).rejects.toThrow('modelo configurado');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Google explícito conserva su file part, presupuesto y uso sin inventar tarifa audio', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'google-ficticia');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: 'Google sintético' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 4, totalTokenCount: 26 } })));
    const r = await aiSdkTranscriber({ provider: 'google', model: 'gemini-flash-latest' }).transcribe({ bytes: audioSintetico(), contentType: 'audio/wav' });
    expect(r).toMatchObject({ text: 'Google sintético', tokensIn: 22, tokensOut: 4, costUsd: null });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('gemini-flash-latest:generateContent');
    const body = JSON.parse(String(init!.body));
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/wav');
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
  });
  it.each([400,401,402,429,500])('HTTP %s mantiene marca/status y NO repite una petición pagada', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'mensaje sintético', type: 'error' } }, { status })));
    const err = await aiSdkTranscriber().transcribe({ bytes: audioSintetico(), contentType: 'audio/wav' }).catch(e => e);
    expect(esDelProveedor(err)).toBe(true); expect(err.status).toBe(status); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborta una llamada que no responde y no deja un reintento', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    await expect(aiSdkTranscriber().transcribe({ bytes: audioSintetico(), contentType: 'audio/wav', esperaMaximaMs: 15 })).rejects.toMatchObject({ delProveedor: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uso ausente, modelo desconocido o duración no se cobran con tarifas de chat', () => {
    expect(usoDeAudioOpenAi('gpt-4o-mini-transcribe', undefined)).toEqual({ tokensIn: null, tokensOut: null, costUsd: null });
    expect(usoDeAudioOpenAi('otro', { type: 'tokens', input_tokens: 5, output_tokens: 3 }).costUsd).toBeNull();
    expect(usoDeAudioOpenAi('whisper-1', { type: 'duration', seconds: 30 })).toEqual({ tokensIn: null, tokensOut: null, seconds: 30, costUsd: 0.003 });
  });
});

describe('nueve tareas, capacidades y credenciales efectivas', () => {
  it('una llave con espacios no está disponible', () => { vi.stubEnv('OPENAI_API_KEY', '   '); expect(providerAvailable('openai')).toBe(false); });
  it('sin Google y con OpenAI las nueve tienen capacidad y audio usa modelo propio', () => {
    const s = iaSettings(null, providerAvailable);
    expect(Object.keys(s.tasks)).toHaveLength(9);
    for (const task of TASKS) { expect(s.tasks[task].provider).toBe('openai'); expect(proveedorPermitidoParaTarea('openai', task)).toBe(true); }
    expect(s.tasks.transcribir.model).toBe('gpt-4o-mini-transcribe');
  });
  it('las 16 combinaciones de credenciales solo respaldan audio con un proveedor capaz', () => {
    for (let mask = 0; mask < 16; mask++) {
      const hay = (p: typeof PROVIDERS[number]) => Boolean(mask & (1 << PROVIDERS.indexOf(p)));
      const s = iaSettings(null, hay);
      for (const task of TASKS) {
        const existe = PROVIDERS.some(p => hay(p) && proveedorPermitidoParaTarea(p, task));
        expect(proveedorPermitidoParaTarea(s.tasks[task].provider, task), `${mask}/${task}`).toBe(true);
        if (existe) expect(hay(s.tasks[task].provider), `${mask}/${task}`).toBe(true);
      }
    }
  });
  it('respeta modelo explícito de audio y defecto de plataforma, sin volver al de chat', () => {
    const defecto = { ...DEFAULT_TASK_MODELS, transcribir: { provider: 'openai' as const, model: 'gpt-4o-transcribe' } };
    expect(iaSettings(null, providerAvailable, undefined, defecto).tasks.transcribir.model).toBe('gpt-4o-transcribe');
    expect(iaSettings({ ia: { tasks: { transcribir: { provider: 'google', model: 'gemini-2.5-flash' } } } }, () => true).tasks.transcribir).toEqual({ provider: 'google', model: 'gemini-2.5-flash' });
    expect(iaSettings({ ia: { soloProveedor: 'openai' } }, () => false).tasks.transcribir).toEqual(DEFAULT_TASK_MODELS.transcribir);
    expect(iaSettings({ ia: { soloProveedor: 'google' } }, () => false).tasks.transcribir.provider).toBe('google');
  });
  it('proveedor incapaz se explica por capacidad y expone el respaldo efectivo', () => {
    const d = diagnosticarLaIa({ settings: { ia: { tasks: { transcribir: { provider: 'glm', model: 'texto' } } } }, hayLlave: providerAvailable, castigados: () => [] });
    const paso = d.pasos.find(p => p.id === 'transcripcion')!;
    expect(paso.estado).toBe('atencion'); expect(paso.detalle).toContain('capacidad'); expect(paso.detalle).toContain('openai/gpt-4o-mini-transcribe');
  });
  it('la excepción de capacidad de soloProveedor también usa credenciales efectivas', () => {
    const s = iaSettings({ ia: { soloProveedor: 'glm' } }, p => p === 'glm' || p === 'google');
    expect(s.tasks.transcribir).toEqual({ provider: 'google', model: 'gemini-flash-latest' });
    expect(s.tasks.sugerir.provider).toBe('glm');
    const d = diagnosticarLaIa({ settings: { ia: { soloProveedor: 'glm' } }, hayLlave: p => p === 'glm' || p === 'google', castigados: () => [] });
    expect(d.pasos.find(p => p.id === 'transcripcion')!.detalle).toContain('google/gemini-flash-latest');
  });
  it('default incapaz sin respaldo disponible se explica sin afirmar falla del proveedor', () => {
    const defectos = { ...DEFAULT_TASK_MODELS, transcribir: { provider: 'anthropic' as const, model: 'claude' } };
    const d = diagnosticarLaIa({ settings: null, defectos, hayLlave: p => p === 'anthropic', castigados: () => [] });
    const paso = d.pasos.find(p => p.id === 'transcripcion')!;
    expect(paso.estado).toBe('atencion'); expect(paso.detalle).toContain('limitación de capacidad, no una falla');
    expect(d.pasos.find(p => p.id === 'tareas')!.detalle).toContain('entender un audio');
  });
  it('la prueba de texto no afirma haber transcrito ni llama un modelo de chat', async () => {
    const r = await probarLaIa({ settings: null, tarea: 'transcribir' });
    expect(r.contesto).toBe(false); expect(r.motivo).toBeNull(); expect(r.mensaje).toContain('archivo de audio'); expect(fetch).not.toHaveBeenCalled();
  });
});
