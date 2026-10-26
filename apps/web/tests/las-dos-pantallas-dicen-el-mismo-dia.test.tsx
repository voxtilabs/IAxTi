// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { diaLegible } from '../lib/dia';
import { RetencionAviso } from '../components/bandeja/retencion-aviso';

/**
 * Las dos pantallas de retención dicen el MISMO día (#1076).
 *
 * El servidor manda el corte como DÍA (`AAAA-MM-DD`), y dos pantallas lo
 * pintaban de dos maneras: ajustes lo escribía crudo y la ficha de la bandeja
 * lo pasaba por `new Date(...).toLocaleDateString('es-CL')`. Eso es medianoche
 * UTC bajada a la zona del navegador, o sea las 21:00 del día anterior en
 * Chile — así que la bandeja afirmaba que el historial se borraba un día antes
 * de lo que decía ajustes sobre el mismo dato.
 *
 * Es de comportamiento y no de fuente (#564): la pregunta es «qué lee la
 * persona», y eso se contesta montando el componente.
 */
const CORTE = '2026-10-25';

/**
 * La zona se FIJA acá, y no es un detalle: con el TZ de la máquina en UTC
 * —que es como corre CI— el defecto no se ve, porque medianoche UTC bajada a
 * UTC no baja nada. Comprobado mordiendo el arreglo: con `TZ=UTC` la prueba
 * pasaba en verde. Node relee `process.env.TZ` al asignarlo, así que esto
 * alcanza y no hace falta un subproceso.
 */
const zonaOriginal = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Santiago';
});
afterAll(() => {
  process.env.TZ = zonaOriginal;
});

vi.mock('../components/arranque', () => ({
  usePieza: () => ({ dato: { cutoff: CORTE, months: 6 }, estado: 'listo' }),
}));

describe('el día del corte de retención (#1076)', () => {
  it('la ficha de la bandeja escribe el día del corte, no el anterior', () => {
    render(<RetencionAviso />);
    const aviso = screen.getByText(/el historial anterior al/i);
    // El 25, que es lo que mandó el servidor.
    expect(aviso.textContent).toContain('25-10-2026');
    // El 24 es lo que salía por tratar el día como instante: si vuelve, las
    // dos pantallas vuelven a contradecirse.
    expect(aviso.textContent).not.toContain('24-10-2026');
  });

  it('`diaLegible` no se corre, y la forma vieja sí — medido en la misma línea', () => {
    expect(diaLegible(CORTE)).toBe('25-10-2026');
    // Lo que hacía la pantalla antes, con la zona puesta a mano para que esto
    // no dependa del reloj de la máquina: el día baja uno.
    expect(new Date(CORTE).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })).toBe('24-10-2026');
    // Y al otro lado del mundo no se corría, que es lo que hacía al defecto
    // difícil de ver: lo que el cliente leía dependía de dónde estaba sentado.
    expect(new Date(CORTE).toLocaleDateString('es-CL', { timeZone: 'Pacific/Auckland' })).toBe('25-10-2026');
  });
});
