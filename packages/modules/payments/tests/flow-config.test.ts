import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowProvider } from '../domain/providers';
import { flowConfig } from '../domain/flow-config';

const cred = 'synthetic-key-366:synthetic-secret-366';
// `payerEmail` y `expiresAt` son obligatorios en el puerto: Flow exige el
// email del pagador, y sin `timeout` la orden queda pagable para siempre.
const input = { amountClp: 1000, concept: 'Prueba local', linkId: 'local-366', returnUrl: 'https://app.example.invalid', confirmUrl: 'https://api.example.invalid', payerEmail: 'cliente@example.invalid', expiresAt: new Date(Date.now() + 72 * 3_600_000) };
afterEach(() => vi.unstubAllEnvs());

describe('Flow solo usa el destino correspondiente al modo del proveedor', () => {
  it.each([
    ['test', 'staging', 'https://www.flow.cl/api'],
    ['test', 'production', 'https://www.flow.cl/api'],
    ['live', 'staging', 'https://www.flow.cl/api'],
    ['live', 'production', 'https://sandbox.flow.cl/api'],
    ['test', 'staging', 'https://credenciales.example.invalid/api'],
    ['test', 'staging', 'http://sandbox.flow.cl/api'],
    ['test', 'staging', 'https://sandbox.flow.cl@externo.invalid/api'],
    ['test', 'staging', 'https://sandbox.flow.cl/api?destino=otro'],
  ] as const)('rechaza %s en %s con %s sin enviar credenciales', async (mode, entorno, base) => {
    vi.stubEnv('IAXTI_ENV', entorno);
    vi.stubEnv('FLOW_API_BASE', base);
    const fetcher = vi.fn<typeof fetch>();
    await expect(createFlowProvider(fetcher).createLink({ ...input, mode }, cred)).rejects.toThrow(/Flow|FLOW_API_BASE/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', 'apiKey:secretKey', 'ejemplo:default', '<apiKey>:<secretKey>', 'your_api_key:your_secret_key', 'a:', 'a:b:c', 'a: b'])('rechaza credencial de ejemplo/incompleta (%s) antes de enviar', async (credencial) => {
    vi.stubEnv('FLOW_API_BASE', 'https://sandbox.flow.cl/api');
    const fetcher = vi.fn<typeof fetch>();
    await expect(createFlowProvider(fetcher).createLink(input, credencial)).rejects.toThrow(/credenciales válidas/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['test', 'staging', 'https://sandbox.flow.cl/api'],
    ['live', 'production', 'https://www.flow.cl/api'],
  ] as const)('envía %s al destino oficial, firmado y sin seguir redirecciones', async (mode, entorno, base) => {
    vi.stubEnv('IAXTI_ENV', entorno);
    vi.stubEnv('FLOW_API_BASE', base);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ url: `${base}/pago`, token: 'local', flowOrder: 366 }));
    const link = await createFlowProvider(fetcher).createLink({ ...input, mode }, cred);
    expect(link.externalId).toBe('366');
    expect(fetcher).toHaveBeenCalledWith(`${base}/payment/create`, expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const body = new URLSearchParams(fetcher.mock.calls[0][1]?.body as string);
    expect(body.get('s')).toMatch(/^[a-f0-9]{64}$/);
    expect(body.get('secretKey')).toBeNull();
  });

  it('sin URL definida usa sandbox; live requiere configurar su URL explícita', () => {
    vi.stubEnv('FLOW_API_BASE', undefined);
    vi.stubEnv('IAXTI_ENV', 'production');
    expect(flowConfig(cred).base).toBe('https://sandbox.flow.cl/api');
    expect(() => flowConfig(cred, 'live')).toThrow(/destino oficial/);
  });

  /**
   * #575. Esta tabla tenía una fila `['test', 'staging', '']` que afirmaba que
   * una `FLOW_API_BASE` DECLARADA Y VACÍA rechazaba el envío. Era cierto, y por
   * accidente: `(process.env.FLOW_API_BASE ?? SANDBOX)` dejaba `base = ''`, y el
   * error que saltaba acusaba a la variable de «no corresponder al destino
   * oficial» cuando lo que pasaba es que estaba vacía. La prueba congelaba ese
   * diagnóstico equivocado como si fuera la intención.
   *
   * Ahora en blanco es lo mismo que ausente —que es todo el issue— y por lo
   * tanto sandbox. Lo que protege el modo live no se movió: su destino sigue
   * teniendo que estar escrito, y el por-defecto es sandbox, así que una
   * variable vacía NO habilita cobros de verdad. Eso es lo que esta prueba
   * fija, y es la única razón por la que vaciarla puede ser aceptable.
   */
  it('una FLOW_API_BASE en blanco es lo mismo que ausente, y live sigue cerrado (#575)', () => {
    vi.stubEnv('FLOW_API_BASE', '');
    vi.stubEnv('IAXTI_ENV', 'production');
    expect(flowConfig(cred).base).toBe('https://sandbox.flow.cl/api');
    expect(() => flowConfig(cred, 'live')).toThrow(/destino oficial/);
  });
});
