import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cancelar un link de pago emitido (#460).
 *
 * `POST /payments/links/:id/cancel` existe desde #60 y no la llamaba
 * nadie: un link con el monto equivocado —o el de un pedido que se cayó—
 * se quedaba vivo hasta que alguien lo pagaba, y después eso es una
 * devolución.
 */
const PAGOS = readFileSync(join(__dirname, '..', 'components', 'pagos.tsx'), 'utf8');

describe('cancelar un link', () => {
  it('se cancela desde la lista de links', () => {
    expect(PAGOS).toContain('`/payments/links/${l.id}/cancel`');
  });

  it('solo se ofrece en los que todavía no se pagan', () => {
    expect(PAGOS).toContain("l.status === 'created' || l.status === 'sent'");
  });

  it('la lista se vuelve a pedir después', () => {
    const i = PAGOS.indexOf('/cancel`');
    expect(PAGOS.slice(i, i + 300)).toContain('await cargar()');
  });

  it('un link pagado lo rechaza el servidor, y se muestra su motivo', () => {
    // Cancelar algo ya pagado no es cancelar: es devolver, y eso lo hace
    // el proveedor.
    expect(PAGOS).toContain('setAviso((err as Error).message)');
  });
});
