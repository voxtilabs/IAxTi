import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../lib/api';

/**
 * Un cuerpo vacío es «no hay nada», no un error (#1387).
 *
 * `GET /agents/configurador` responde 200 sin cuerpo cuando no hay propuesta
 * pendiente —el caso normal—, y `res.json()` lanzaba «Unexpected end of JSON
 * input»: «Ver lo que quedó configurado» mostraba «Algo falló» a cualquier
 * negocio. Se prueba en `apiFetch` porque ahí se arregla la clase entera.
 */
const config = { apiUrl: 'http://api.local' } as Parameters<typeof apiFetch>[0];
const session = { access_token: 't' } as Parameters<typeof apiFetch>[1];
const responder = (r: Response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(r);

afterEach(() => vi.restoreAllMocks());

describe('apiFetch y el cuerpo vacío', () => {
  it('un 200 sin cuerpo se lee null', async () => {
    responder(new Response('', { status: 200 }));
    await expect(apiFetch(config, session, 'negocio', '/agents/configurador')).resolves.toBeNull();
  });

  it('un 204 se lee null', async () => {
    responder(new Response(null, { status: 204 }));
    await expect(apiFetch(config, session, 'negocio', '/algo')).resolves.toBeNull();
  });

  it('un cuerpo JSON se sigue leyendo igual', async () => {
    responder(new Response(JSON.stringify({ propuesta: { id: 'p1' } }), { status: 200 }));
    await expect(apiFetch(config, session, 'negocio', '/agents/configurador')).resolves.toEqual({ propuesta: { id: 'p1' } });
  });

  it('un error sigue siendo un error, con su código', async () => {
    responder(new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'No encontramos eso.', requestId: 'req_1' }), { status: 404 }));
    await expect(apiFetch(config, session, 'negocio', '/x')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 } satisfies Partial<ApiError>);
  });
});
