// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CitaDto } from '../lib/api';

/**
 * El calendario de la agenda (#1368), montado y usado.
 *
 * Lo que se pide: la grilla del mes navegable, el mes visible traído por
 * rango (la API ya lo servía), y un día elegido que muestra sus citas con
 * las MISMAS filas que la lista. Las fechas de los fixtures se construyen
 * RELATIVAS a hoy — la grilla gira alrededor del día corriente por diseño,
 * y una prueba que ancla su cita al 15 de noviembre se rompe el 16.
 */

vi.mock('../components/arranque', () => ({
  useArranque: () => ({ arranque: { permisos: ['calendar.book'] } }),
}));
/* El panel de Google y los demás bloques laterales no son el asunto: los
   apago para que la única API viva en la prueba sea /agenda. */
vi.mock('../components/google-calendar', () => ({ GoogleCalendarConnection: () => null }));
vi.mock('../components/por-que-se-cancelan', () => ({ PorQueSeCancelan: () => null }));
vi.mock('../components/dar-una-hora', () => ({ DarUnaHora: () => null }));
const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a', config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...await original<typeof import('../lib/api')>(), apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Agenda } from '../components/agenda';

const pedir = vi.mocked(apiFetch);

/* Radix usa APIs de puntero que jsdom no trae (el Select y el Dialog caen
   con `hasPointerCapture is not a function`). */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

const ahora = new Date();
const hoyA10 = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 10, 0);
const citaHoy: CitaDto = {
  id: 'c1', contactId: 'co1', ownerId: 'u1',
  startsAt: hoyA10.toISOString(),
  endsAt: new Date(hoyA10.getTime() + 45 * 60_000).toISOString(),
  status: 'confirmed', title: 'Corte de Camila',
  cancelReason: null, googleEventId: null, googleSyncError: null, avisoError: null,
};

/** La etiqueta del día en la grilla: «19 de noviembre», como la pinta. */
const fechaDe = (d: Date) =>
  d.toLocaleDateString('es-CL', { day: 'numeric', month: 'long' });
const hoyEtiqueta = `${fechaDe(hoyA10)}, 1 hora`;

/** Las peticiones de rango que ya salieron, con desde/hasta como fecha. */
const rangos = () =>
  pedir.mock.calls
    .map((c) => (typeof c[3] === 'string' ? c[3] : ''))
    .filter((p) => p.startsWith('/agenda?'))
    .map((p) => {
      const q = new URLSearchParams(p.slice(p.indexOf('?') + 1));
      return { desde: new Date(q.get('desde')!), hasta: new Date(q.get('hasta')!) };
    });

/** La API sirve la cita de HOY solo si el rango pedido la incluye: así el
    test de navegación comprueba el rango POR LO QUE VUELVE, no por la URL. */
beforeEach(() => {
  pedir.mockReset();
  pedir.mockImplementation(async (_c, _s, _t, path: string) => {
    if (typeof path === 'string' && path.startsWith('/agenda?')) {
      const q = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const desde = new Date(q.get('desde')!);
      const hasta = new Date(q.get('hasta')!);
      const dentro = new Date(citaHoy.startsAt) >= desde && new Date(citaHoy.startsAt) < hasta;
      return dentro ? [citaHoy] : [];
    }
    if (path === '/agenda/c1/estado') return { ok: true };
    throw new Error('ruta inesperada: ' + String(path));
  });
});

const montar = async () => {
  render(<Agenda />);
  // La lista (la vista por defecto) cargó: el arranque de toda la pantalla.
  await waitFor(() => expect(screen.getByText('Corte de Camila')).toBeInTheDocument());
};

describe('la agenda muestra un calendario (#1368)', () => {
  it('la pestaña Calendario abre la grilla del mes con hoy distinguido', async () => {
    await montar();
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('tab', { name: 'Calendario' }));

    const celdaHoy = await screen.findByRole('button', { name: hoyEtiqueta });
    expect(celdaHoy).toHaveAttribute('aria-current', 'date');
    // La hora de la cita está en la celda (es-CL lleva su meridiem): el día
    // se lee sin abrir nada.
    expect(within(celdaHoy).getByText(/10:00/)).toBeInTheDocument();
  });

  it('navegar de mes pide a la API el rango del mes que se va a ver', async () => {
    await montar();
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('tab', { name: 'Calendario' }));
    await screen.findByRole('button', { name: hoyEtiqueta });

    const antes = rangos().length;
    await usuario.click(screen.getByRole('button', { name: 'Mes siguiente' }));

    const mesSiguiente = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 15);
    await waitFor(() => {
      const ultima = rangos().at(-1);
      expect(ultima).toBeDefined();
      // El día 15 del mes nuevo tiene que quedar ADENTRO del rango pedido:
      // es lo que la grilla va a pintar y lo que la API tiene que traer.
      expect(ultima!.desde.getTime()).toBeLessThanOrEqual(mesSiguiente.getTime());
      expect(ultima!.hasta.getTime()).toBeGreaterThan(mesSiguiente.getTime());
      expect(rangos().length).toBeGreaterThan(antes);
    });
    // Y la cita de hoy ya no está en el rango: el día de hoy no está en la
    // grilla del mes siguiente.
    expect(screen.queryByRole('button', { name: hoyEtiqueta })).not.toBeInTheDocument();
    const titulo = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1)
      .toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
    expect(screen.getByText(titulo)).toBeInTheDocument();
  });

  it('«Hoy» vuelve al mes corriente', async () => {
    await montar();
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('tab', { name: 'Calendario' }));
    await usuario.click(screen.getByRole('button', { name: 'Mes siguiente' }));
    await usuario.click(screen.getByRole('button', { name: 'Mes siguiente' }));

    await usuario.click(screen.getByRole('button', { name: 'Hoy' }));
    expect(await screen.findByRole('button', { name: hoyEtiqueta })).toHaveAttribute(
      'aria-current',
      'date',
    );
  });

  it('elegir el día muestra sus citas con las mismas acciones que la lista', async () => {
    await montar();
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('tab', { name: 'Calendario' }));
    await usuario.click(await screen.findByRole('button', { name: hoyEtiqueta }));

    // Las mismas filas: contacto, etiqueta de estado y los botones del
    // estado — porque es el MISMO componente que pinta la lista. La cita
    // fixture está confirmada: ofrece Vino, No llegó y Cancelar, y NO
    // Confirmar (eso es de una propuesta).
    const panel = await screen.findByText('Corte de Camila');
    const fila = panel.closest('ul')!;
    expect(within(fila).getByRole('button', { name: 'Vino' })).toBeInTheDocument();
    expect(within(fila).getByRole('button', { name: 'No llegó' })).toBeInTheDocument();
    expect(within(fila).queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();

    // Cancelar abre el MISMO dialog del motivo que la lista.
    await usuario.click(within(panel.closest('ul')!).getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByText('Cancelar esta hora')).toBeInTheDocument();

    const campo = screen.getByLabelText('Motivo de la cancelación');
    // Char a char: en un solo `type` el Dialog de esta pantalla pierde
    // teclas (reproducido en el tablero, #1367).
    for (const letra of 'se enfermó') await usuario.type(campo, letra);
    await usuario.click(screen.getByRole('button', { name: 'Cancelar la hora' }));

    await waitFor(() => {
      const post = pedir.mock.calls.find(
        (c) => c[3] === '/agenda/c1/estado' && c[4]?.method === 'POST',
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![4]?.body))).toEqual({
        estado: 'cancelled',
        motivo: 'se enfermó',
      });
    });
  });

  it('un día sin citas lo dice y no se queda mudo', async () => {
    await montar();
    const usuario = userEvent.setup();
    await usuario.click(screen.getByRole('tab', { name: 'Calendario' }));
    await usuario.click(screen.getByRole('button', { name: 'Mes siguiente' }));

    // El día 15 del mes siguiente no tiene citas (la fixture solo tiene hoy):
    // su celda dice «sin horas» y elegirlo lo repite abajo, en claro.
    const etiqueta = `${fechaDe(new Date(ahora.getFullYear(), ahora.getMonth() + 1, 15))}, sin horas`;
    await usuario.click(await screen.findByRole('button', { name: etiqueta }));
    expect(await screen.findByText('Ese día no tiene horas agendadas.')).toBeInTheDocument();
  });
});
