import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowProvider, createSimuladoProvider, flowSign } from '../domain/providers';

// La orden de Flow y su plazo (#60/#61). Dos cosas que costaban plata:
//
// 1. Nunca mandábamos `timeout`, y la doc de Flow no deja lugar a dudas: "Si
//    no se envía este parámetro la orden no expirará y estará vigente para
//    pago por tiempo indefinido". El vencimiento vivía solo en payment_links,
//    así que un link 'expired' o 'cancelled' seguía siendo cobrable del otro
//    lado: el que la peluquería mandó en marzo se pagaba en septiembre al
//    precio de marzo.
// 2. `verifyWebhook` decía verificar y no verificaba nada — solo exigía un
//    secreto que Flow nunca manda.

const CRED = 'synthetic-key-608:synthetic-secret-608';
const SANDBOX = 'https://sandbox.flow.cl/api';

function entrada(expiresAt: Date) {
  return {
    mode: 'test' as const,
    amountClp: 45_000,
    concept: 'Manicure mensual',
    linkId: 'link-608',
    returnUrl: 'https://app.example.invalid/pagos/gracias',
    confirmUrl: 'https://api.example.invalid/webhooks/payments/p-608',
    payerEmail: 'clienta@example.invalid',
    expiresAt,
  };
}

function conSandbox() {
  vi.stubEnv('IAXTI_ENV', 'staging');
  vi.stubEnv('FLOW_API_BASE', SANDBOX);
  return vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ url: `${SANDBOX}/pago`, token: 'tok-608', flowOrder: 608 }));
}

afterEach(() => vi.unstubAllEnvs());

describe('la orden de Flow nace con plazo (#60)', () => {
  it('manda timeout en segundos hasta el vencimiento, y va dentro de la firma', async () => {
    const fetcher = conSandbox();
    await createFlowProvider(fetcher).createLink(entrada(new Date(Date.now() + 3_600_000)), CRED);

    const body = new URLSearchParams(fetcher.mock.calls[0][1]?.body as string);
    // Una hora, con holgura por lo que tarde la prueba en llegar hasta acá.
    expect(Number(body.get('timeout'))).toBeGreaterThan(3_590);
    expect(Number(body.get('timeout'))).toBeLessThanOrEqual(3_600);

    // Y firmado: un `timeout` fuera de `s` sería un parámetro que Flow ignora.
    const params: Record<string, string> = {};
    for (const [k, v] of body) if (k !== 's') params[k] = v;
    expect(body.get('s')).toBe(flowSign(params, 'synthetic-secret-608'));
  });

  it('el email del pagador es el que le pasan, no uno nuestro', async () => {
    const fetcher = conSandbox();
    await createFlowProvider(fetcher).createLink(entrada(new Date(Date.now() + 3_600_000)), CRED);
    const body = new URLSearchParams(fetcher.mock.calls[0][1]?.body as string);
    expect(body.get('email')).toBe('clienta@example.invalid');
  });

  it('sin email del pagador no se crea la orden: Flow lo exige', async () => {
    const fetcher = conSandbox();
    await expect(
      createFlowProvider(fetcher).createLink(
        { ...entrada(new Date(Date.now() + 3_600_000)), payerEmail: '  ' },
        CRED,
      ),
    ).rejects.toThrow(/email del pagador/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('con el vencimiento ya pasado no se crea nada que alguien pueda pagar', async () => {
    const fetcher = conSandbox();
    await expect(
      createFlowProvider(fetcher).createLink(entrada(new Date(Date.now() - 1_000)), CRED),
    ).rejects.toThrow(/vencido/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('de dónde sale la autenticidad de cada confirmación (#61)', () => {
  it('Flow no firma: lo declara, y su verifyWebhook no autentica a nadie', () => {
    const flow = createFlowProvider();
    expect(flow.webhookAuth).toBe('consulta-al-proveedor');
    // Un token cualquiera con un secreto cualquiera NO es una confirmación
    // verificada. Antes esto devolvía true y por eso el guard parecía tener
    // sentido; el pago real, en cambio, llegaba sin secreto y se iba con 401.
    expect(flow.verifyWebhook('token=cualquiera', {}, 'cualquier-secreto')).toBe(false);
  });

  it('el simulador sí firma el cuerpo, y lo declara', () => {
    expect(createSimuladoProvider().webhookAuth).toBe('firma-en-el-cuerpo');
  });
});
