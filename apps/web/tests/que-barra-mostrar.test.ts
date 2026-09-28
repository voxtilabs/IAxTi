import { describe, expect, it } from 'vitest';
import { queBarraMostrar } from '../lib/nav';

/**
 * Qué barra se muestra y cuándo se avisa (#679).
 *
 * El defecto no fue de dibujo: fue de decisión. «No pude preguntarle a la API» y
 * «este plan no trae módulos» eran el mismo valor, y la pantalla los mostraba
 * igual — sin barra y sin una palabra—. Acá están separados, y separados se
 * pueden probar sin navegador.
 */
const ITEMS = [{ label: 'Contactos', path: '/contactos', permission: 'crm.contacts.read' }];

describe('queBarraMostrar', () => {
  it('lo del servidor manda cuando llegó', () => {
    const r = queBarraMostrar({ delServidor: ITEMS, delNavegador: null, falloElNavegador: false });
    expect(r).toEqual({ items: ITEMS, avisar: false });
  });

  it('una lista VACÍA del servidor es una respuesta, no un problema', () => {
    // Un plan sin módulos es legítimo. Si esto avisara, el producto estaría
    // gritando por algo que está bien configurado.
    const r = queBarraMostrar({ delServidor: [], delNavegador: ITEMS, falloElNavegador: true });
    expect(r).toEqual({ items: [], avisar: false });
  });

  it('si el servidor no pudo, se usa lo que trajo el navegador', () => {
    // El servidor pregunta por la red interna y el navegador por la pública:
    // son dos caminos, y cuando uno se cae el otro suele andar. Eso es lo que
    // convierte una pantalla sin barra en una pantalla normal.
    const r = queBarraMostrar({ delServidor: null, delNavegador: ITEMS, falloElNavegador: false });
    expect(r).toEqual({ items: ITEMS, avisar: false });
  });

  it('mientras el navegador todavía pregunta, no se avisa nada', () => {
    // Un aviso que aparece y se va solo enseña a ignorar los avisos.
    const r = queBarraMostrar({ delServidor: null, delNavegador: null, falloElNavegador: false });
    expect(r).toEqual({ items: [], avisar: false });
  });

  it('si ninguno de los dos pudo, se avisa', () => {
    // Éste es el criterio del issue: un menú vacío no puede volver a ser el
    // mensaje de error.
    const r = queBarraMostrar({ delServidor: null, delNavegador: null, falloElNavegador: true });
    expect(r).toEqual({ items: [], avisar: true });
  });
});
