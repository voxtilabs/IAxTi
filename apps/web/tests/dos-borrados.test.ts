import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dos borrados que existían y no llamaba nadie (#480).
 *
 * `DELETE /webhooks-salientes/:id` (#71) y `DELETE /notifications/push`
 * (#75). El guard no los veía porque las mismas rutas tienen `GET` o
 * `POST` con pantalla.
 */
const WEBHOOKS = readFileSync(join(__dirname, '..', 'components', 'webhooks-salientes.tsx'), 'utf8');
const AVISOS = readFileSync(join(__dirname, '..', 'components', 'preferencias-avisos.tsx'), 'utf8');

describe('borrar un webhook saliente', () => {
  it('se borra desde su fila', () => {
    expect(WEBHOOKS).toContain('`/webhooks-salientes/${w.id}`, { method: \'DELETE\' }');
  });

  it('sigue existiendo el apagado, que es otra cosa', () => {
    // Apagar deja la URL y su secreto guardados; borrar los saca.
    expect(WEBHOOKS).toContain('/active`');
  });
});

describe('dejar de recibir push en este navegador', () => {
  it('se da de baja en el navegador Y en el servidor', () => {
    // Solo lo segundo dejaría al navegador suscrito, y el servidor le
    // mandaría a una suscripción que ya no reconoce.
    expect(AVISOS).toContain("method: 'DELETE'");
    expect(AVISOS).toContain('await suscripcion.unsubscribe()');
  });

  it('manda el endpoint, que es lo que la ruta pide', () => {
    expect(AVISOS).toContain('endpoint: suscripcion.endpoint');
  });

  it('solo se ofrece si está activo', () => {
    expect(AVISOS).toContain("{estado === 'activo' && (");
  });

  it('vuelve al estado «listo», no a «negado»', () => {
    // Apagarlo desde el navegador quema el permiso; desde acá se puede
    // volver a encender con un clic.
    const i = AVISOS.indexOf('async function desactivar');
    expect(AVISOS.slice(i, i + 1200)).toContain("setEstado('listo')");
  });
});
