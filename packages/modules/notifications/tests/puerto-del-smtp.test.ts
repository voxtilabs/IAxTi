import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * El puerto del SMTP, cuando el compose pasa la variable vacía (#985, #810).
 *
 * Esto era `Number(SMTP_PORT ?? 587)`, y el compose pasa `SMTP_PORT` sin `:?`
 * ni defecto. Sin configurar en Dokploy la variable no llega `undefined`: llega
 * como **cadena vacía**, y `'' ?? 587` es `''`, y `Number('')` es **0**.
 *
 * O sea que el transporte se armaba contra el puerto 0. Nodemailer no conecta,
 * `sendNotificationEmail` devuelve `false`, y el consumidor lo trata como
 * mejor-esfuerzo —«un rebote no puede tumbar el aviso de la campana»—: los
 * correos no salían y no había nada que mirar. Es el mismo modo de falla que el
 * comentario de `remitente()` cuenta de `SMTP_FROM`, por la misma puerta.
 *
 * Lo midió #953, al barrer las variables opcionales del compose.
 *
 * Se espía `createTransport` porque lo que hay que comprobar es el puerto que
 * se le pasa: conectar de verdad no es parte de esto.
 */
const createTransport = vi.fn(() => ({
  sendMail: vi.fn(async () => ({ accepted: ['alguien@ejemplo.cl'] })),
}));
vi.mock('nodemailer', () => ({ createTransport }));

const { resetSmtp, sendNotificationEmail } = await import('../application/email');

const ENV = { ...process.env };
const CLIENTE = {} as PoolClient;
const AVISO = { tenantId: 't', userId: 'u', para: 'alguien@ejemplo.cl', title: 'Hola' };

const conPuerto = async (valor: string | undefined) => {
  Object.assign(process.env, {
    SMTP_HOST: 'smtp.resend.com',
    SMTP_USER: 'resend',
    SMTP_PASS: 're_loquesea',
    SMTP_FROM: 'IAxTi <avisos@iaxti.cl>',
  });
  if (valor === undefined) delete process.env.SMTP_PORT;
  else process.env.SMTP_PORT = valor;
  resetSmtp();
  await sendNotificationEmail(CLIENTE, AVISO);
  return createTransport.mock.calls.at(-1)?.[0] as unknown as { port: number; secure: boolean };
};

beforeEach(() => createTransport.mockClear());
afterEach(() => {
  process.env = { ...ENV };
  resetSmtp();
});

describe('el puerto del SMTP', () => {
  it('con la variable VACÍA usa 587, no 0', async () => {
    const opciones = await conPuerto('');
    expect(opciones.port).toBe(587);
    expect(opciones.secure).toBe(false);
  });

  it('ausente también usa 587', async () => {
    expect((await conPuerto(undefined)).port).toBe(587);
  });

  it('con 465 usa 465 y prende TLS', async () => {
    const opciones = await conPuerto('465');
    expect(opciones.port).toBe(465);
    expect(opciones.secure).toBe(true);
  });

  it('un valor que no es número cae al defecto y lo DICE', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await conPuerto('el-que-sea')).port).toBe(587);
    expect(String(avisos.mock.calls[0]?.[0])).toContain('SMTP_PORT');
    avisos.mockRestore();
  });
});
