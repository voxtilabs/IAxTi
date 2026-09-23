import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cancelar en un clic (#460, SPEC §6).
 *
 * `POST /billing/cancelar` existía desde #67 y no la llamaba nadie:
 * cancelar había que pedirlo por escrito, que es exactamente lo que la
 * spec no quería. Un producto que se contrata solo y se cancela hablando
 * con alguien no se cancela: se abandona, y la cuenta sigue cobrando.
 */
const CANCELAR = readFileSync(join(__dirname, '..', 'components', 'cancelar-suscripcion.tsx'), 'utf8');
const FACTURACION = readFileSync(join(__dirname, '..', 'components', 'facturacion.tsx'), 'utf8');

describe('cancelar la suscripción', () => {
  it('está en Facturación, donde se mira cuánto se paga', () => {
    expect(FACTURACION).toContain('<CancelarSuscripcion');
  });

  it('no se ofrece si ya está cancelada', () => {
    expect(FACTURACION).toContain("sub.status !== 'cancelled'");
  });

  it('llama a la ruta que ya existía', () => {
    expect(CANCELAR).toContain("'/billing/cancelar'");
    expect(CANCELAR).toContain("method: 'POST'");
  });

  it('el motivo es opcional y no se manda vacío', () => {
    // Un formulario obligatorio para irse es una hoop de retención: la
    // spec pide un clic, no una entrevista de salida.
    expect(CANCELAR).toContain('motivo.trim() ? { motivo: motivo.trim() } : {}');
  });

  it('el archivo se descarga en el mismo gesto', () => {
    // La ruta GENERA la exportación en la misma transacción y la devuelve
    // entera; pedirla después de cancelar sería pedirle al cliente que
    // confíe justo cuando decidió dejar de hacerlo.
    expect(CANCELAR).toContain('r.exportacion');
    expect(CANCELAR).toContain('a.download');
  });

  it('dice qué pasa después, no solo que se canceló', () => {
    expect(CANCELAR).toContain('solo lectura');
    expect(CANCELAR).toMatch(/hecho\.mensaje/);
  });
});
