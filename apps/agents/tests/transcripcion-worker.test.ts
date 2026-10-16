import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { receiveInbound } from '@iaxti/module-conversations';
import { MAX_AUDIO_BYTES } from '@iaxti/module-agents';
import { leerAudioAcotado, processSuggest } from '../src/copilot';
import type { Pool } from 'pg';

// No se simula el puerto ni el caso de uso de transcripción: solo HTTP/storage.
vi.mock('@iaxti/module-agents', async original => ({
  ...await original<typeof import('@iaxti/module-agents')>(),
  autoRespondForInbound: async () => ({ action: 'none' }),
}));
let pool: Pool;
beforeAll(async () => { pool = createPool(); await runMigrations(pool); });
afterAll(async () => { await pool.end(); });
beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'key-sintetica'); vi.stubEnv('OPENAI_API_BASE', 'https://audio.invalid/v1');
  for (const name of ['GOOGLE_GENERATIVE_AI_API_KEY','ANTHROPIC_API_KEY','GLM_API_KEY']) vi.stubEnv(name, '');
  vi.stubEnv('R2_ENDPOINT', 'https://storage.invalid'); vi.stubEnv('R2_BUCKET_ADJUNTOS', 'pruebas');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'storage-sintetico'); vi.stubEnv('R2_SECRET_ACCESS_KEY', 'storage-sintetico');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('el worker sin Google descarga y transcribe con OpenAI por su API de audio', async () => {
  const tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('worker-audio-864') RETURNING id")).rows[0].id;
  const entrada = await withTenant(pool, tenant, c => receiveInbound(c, { tenantId: tenant, channel: 'simulador', phone: '+56974444864', type: 'audio', attachments: [{ key: `${tenant}/audio.ogg`, contentType: 'audio/ogg' }] }));
  vi.stubGlobal('fetch', vi.fn(async url => String(url).startsWith('https://storage.invalid')
    ? new Response(new Uint8Array([79,103,103,83]))
    : Response.json({ text: 'respuesta sintética', usage: { type: 'tokens', input_tokens: 10, output_tokens: 3 } })));
  const r = await processSuggest(pool, { tenantId: tenant, conversationId: entrada.conversation.id, messageId: entrada.message.id, audioKey: `${tenant}/audio.ogg`, audioType: 'text/plain' /* el MIME del job no es autoridad */ });
  expect(r.transcribed).toBe(true);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toHaveLength(2);
  expect(String(vi.mocked(fetch).mock.calls[1][0])).toBe('https://audio.invalid/v1/audio/transcriptions');
});
it('rechaza Content-Length excesivo sin leer el cuerpo', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  await expect(leerAudioAcotado(new Response(body, { headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) } }))).rejects.toThrow('16 MiB');
  expect(cancel).toHaveBeenCalledOnce();
});
it('corta una descarga que excede el límite aunque no declare tamaño', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_AUDIO_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel });
  await expect(leerAudioAcotado(new Response(body))).rejects.toThrow('16 MiB');
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['otro-tenant/audio.ogg', 'propio-distinto', 'otra-conversacion'])('rechaza origen %s antes de firmar o descargar', async caso => {
  const tenant = (await pool.query("INSERT INTO tenants(name) VALUES ('origen-audio-864') RETURNING id")).rows[0].id;
  const entrada = await withTenant(pool, tenant, c => receiveInbound(c, { tenantId: tenant, channel: 'simulador', phone: '+56974444865', type: 'audio', attachments: [{ key: `${tenant}/real.ogg`, contentType: 'audio/ogg' }] }));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No debe descargar ni enviar'); }));
  const r = await processSuggest(pool, { tenantId: tenant, conversationId: caso === 'otra-conversacion' ? '00000000-0000-4000-8000-000000000000' : entrada.conversation.id, messageId: entrada.message.id, audioKey: caso === 'propio-distinto' ? `${tenant}/otro.ogg` : caso === 'otra-conversacion' ? `${tenant}/real.ogg` : caso });
  expect(r.transcribed).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
