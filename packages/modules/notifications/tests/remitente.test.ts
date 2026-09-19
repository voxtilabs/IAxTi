import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSmtp, sendNotificationEmail } from '../application/email';
import type { PoolClient } from 'pg';

/**
 * El remitente tiene que ser una dirección de correo.
 *
 * Era `SMTP_FROM ?? SMTP_USER`, y ese respaldo servía con un proveedor donde
 * el usuario ES la casilla. Con Resend el usuario es literalmente "resend":
 * cada correo habría salido con `From: resend` y el servidor lo rechaza.
 *
 * Lo que lo hacía peligroso es el modo de fallar. `sendNotificationEmail` devuelve un
 * booleano y el consumidor lo trata como mejor-esfuerzo, así que el rechazo
 * se tragaba en silencio: la campana funciona, los correos no llegan, y
 * nadie se entera hasta que alguien dice "nunca me llegó la invitación".
 */
const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  resetSmtp();
});

const CLIENTE = {} as PoolClient;
const AVISO = {
  tenantId: 't',
  userId: 'u',
  para: 'alguien@ejemplo.cl',
  title: 'Te invitaron a un negocio',
};

describe('el remitente del correo', () => {
  it('con Resend y sin SMTP_FROM no manda, y lo dice', async () => {
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(process.env, {
      SMTP_HOST: 'smtp.resend.com',
      SMTP_PORT: '465',
      SMTP_USER: 'resend',
      SMTP_PASS: 're_loquesea',
    });
    delete process.env.SMTP_FROM;
    resetSmtp();

    // No manda. Y sobre todo: no manda con `From: resend`.
    expect(await sendNotificationEmail(CLIENTE, AVISO)).toBe(false);
    expect(avisos).toHaveBeenCalled();
    const texto = String(avisos.mock.calls[0][0]);
    expect(texto).toContain('SMTP_FROM');
    expect(texto).toContain('NO se están enviando');
    avisos.mockRestore();
  });

  it('acepta "algo@dominio" y "Nombre <algo@dominio>"', async () => {
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const from of ['avisos@iaxti.cl', 'IAxTi <avisos@iaxti.cl>']) {
      Object.assign(process.env, {
        SMTP_HOST: 'smtp.resend.com',
        SMTP_PORT: '465',
        SMTP_USER: 'resend',
        SMTP_PASS: 're_loquesea',
        SMTP_FROM: from,
      });
      resetSmtp();
      // Llega a intentar el envío (falla la conexión, no la configuración):
      // lo que importa es que NO se cortó por remitente inválido.
      await sendNotificationEmail(CLIENTE, AVISO).catch(() => {});
      expect(avisos, `rechazó "${from}" y es válido`).not.toHaveBeenCalled();
    }
    avisos.mockRestore();
  });

  it('sin SMTP configurado sigue sin quejarse: apagado no es un error', async () => {
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k];
    resetSmtp();
    expect(await sendNotificationEmail(CLIENTE, AVISO)).toBe(false);
    expect(avisos).not.toHaveBeenCalled();
    avisos.mockRestore();
  });
});
