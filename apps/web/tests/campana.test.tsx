// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Arranque, Pieza } from '../components/arranque';
import type { AvisosDto } from '../components/campana';

const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a', config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(),
  useSession: () => contexto,
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...await original<typeof import('../lib/api')>(), apiFetch: vi.fn(),
}));
import { ApiError, apiFetch } from '../lib/api';
import { Campana } from '../components/campana';
import { ProveedorDeArranque, useArranque } from '../components/arranque';

const pedir = vi.mocked(apiFetch);
const datos = (title = 'Aviso del negocio A'): AvisosDto => ({ unread: 1, items: [{
  id: title, title, type: 'mention', body: 'Una tarea requiere tu atención.',
  link: '#detalle', readAt: null, createdAt: '2026-10-16T12:00:00Z', groupCount: 1,
}] });
const arranque = (avisos: Pieza<AvisosDto>) => ({ avisos } as Arranque);
function diferida<T>() {
  let resolver!: (dato: T) => void;
  const promesa = new Promise<T>((resolve) => { resolver = resolve; });
  return { promesa, resolver };
}
const Arbol = () => <ProveedorDeArranque><Campana /></ProveedorDeArranque>;
const resolver = async <T,>(d: ReturnType<typeof diferida<T>>, dato: T) => {
  await act(async () => { d.resolver(dato); await d.promesa; });
};
const abrir = () => fireEvent.keyDown(screen.getByRole('button', { name: /^Avisos/ }), { key: 'Enter' });
const lista = () => screen.getByRole('region', { name: 'Lista de avisos' });
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); };
let numero = 0;
beforeEach(() => {
  // El caché real del arranque es por negocio+sesión; cada caso es una sesión distinta.
  contexto.tenant = `negocio-${++numero}`;
  contexto.session = { access_token: `sesion-${numero}` };
  pedir.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe('campana: lo que ve la persona al cargar, refrescar y cambiar de negocio (#588)', () => {
  it('el arranque conserva el identificador del fallo al exponer su error', async () => {
    function Observador() { return <p>{useArranque().error}</p>; }
    pedir.mockRejectedValue(new ApiError('BOOT_FAILED', 'No se pudo cargar.', 500, 'req_arranque'));
    await act(async () => { render(<ProveedorDeArranque><Observador /></ProveedorDeArranque>); });
    expect(screen.getByText('No se pudo cargar. · BOOT_FAILED · req_arranque')).toBeVisible();
  });
  it('distingue carga del arranque de vacío y no duplica la petición inicial', async () => {
    const inicial = diferida<Arranque>();
    pedir.mockReturnValue(inicial.promesa);
    render(<Arbol />);
    abrir();
    expect(lista()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Cargando avisos' })).toBeVisible();
    expect(screen.queryByText('Nada nuevo por ahora')).not.toBeInTheDocument();
    await resolver(inicial, arranque({ estado: 'ok', dato: { items: [], unread: 0 } }));
    expect(lista()).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('region', { name: 'Nada nuevo por ahora' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Configurar avisos' })).toHaveAttribute('href', '/ajustes/notificaciones');
    expect(pedir.mock.calls.map((c) => c[3])).toEqual(['/arranque']);
  });

  it.each(['sin-permiso', 'modulo-apagado'] as const)('el arranque %s no se confunde con vacío ni ofrece reintentar', async (estado) => {
    vi.useFakeTimers();
    pedir.mockResolvedValue(arranque(estado === 'modulo-apagado' ? { estado, modulo: 'notifications' } : { estado }));
    await act(async () => { render(<Arbol />); });
    abrir();
    expect(lista()).toHaveTextContent(estado === 'sin-permiso' ? 'No tienes permiso' : 'desactivados en la plataforma');
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    expect(screen.queryByText('Nada nuevo por ahora')).not.toBeInTheDocument();
    await tick();
    expect(pedir).toHaveBeenCalledTimes(1);
  });

  it.each(['pieza', 'peticion'])('recupera el arranque fallido (%s), conserva code/requestId y permite reintentar', async (fallo) => {
    pedir.mockImplementation(async (_c, _s, _t, ruta) => {
      if (ruta === '/arranque') {
        if (fallo === 'peticion') throw new Error('Arranque no disponible');
        return arranque({ estado: 'falla' });
      }
      throw new ApiError('NOTIFICATIONS_FAILED', 'No pudimos leer los avisos.', 500, 'req_588');
    });
    await act(async () => { render(<Arbol />); });
    abrir();
    expect(lista()).toHaveTextContent('NOTIFICATIONS_FAILED · req_588');
    expect(within(lista()).getByRole('button', { name: 'Copiar' })).toBeVisible();
    pedir.mockResolvedValue(datos());
    await act(async () => { fireEvent.click(within(lista()).getByRole('button', { name: 'Reintentar' })); });
    expect(lista()).toHaveTextContent('Aviso del negocio A');
    expect(lista()).not.toHaveTextContent('NOTIFICATIONS_FAILED');
  });

  it('un 500 del sondeo deja visibles los datos anteriores y su rastro; al recuperarse desaparece el fallo', async () => {
    vi.useFakeTimers();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    pedir.mockRejectedValueOnce(new ApiError('POLL_FAILED', 'No pudimos actualizar los avisos.', 500, 'req_poll'));
    await tick();
    expect(lista()).toHaveTextContent('Aviso del negocio A');
    expect(lista()).toHaveTextContent('POLL_FAILED · req_poll');
    expect(screen.getByLabelText('Avisos, 1 sin leer')).toBeVisible();
    pedir.mockResolvedValueOnce(datos('Aviso actualizado'));
    await act(async () => { fireEvent.click(within(lista()).getByRole('button', { name: 'Reintentar' })); });
    expect(lista()).toHaveTextContent('Aviso actualizado');
    expect(lista()).not.toHaveTextContent('POLL_FAILED');
  });

  it('un 403 del sondeo elimina datos privados y contador; no ofrece reintentar sin permiso', async () => {
    vi.useFakeTimers();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    pedir.mockRejectedValueOnce(new ApiError('FORBIDDEN', 'No tienes permiso.', 403, 'req_permiso'));
    await tick();
    expect(lista()).not.toHaveTextContent('Aviso del negocio A');
    expect(lista()).toHaveTextContent('No tienes permiso');
    expect(screen.getByLabelText('Avisos', { exact: true })).toBeVisible();
    expect(within(lista()).queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    await tick();
    expect(pedir).toHaveBeenCalledTimes(2);
  });

  it.each(['tenant', 'sesion'] as const)('al cambiar %s no copia el arranque anterior ni acepta un sondeo tardío', async (cambio) => {
    vi.useFakeTimers();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos('Privado anterior') }));
    const vista = render(<Arbol />);
    await act(async () => {});
    abrir();
    expect(lista()).toHaveTextContent('Privado anterior');
    const viejo = diferida<AvisosDto>();
    pedir.mockReturnValueOnce(viejo.promesa);
    await tick();
    const nuevo = diferida<Arranque>();
    pedir.mockReturnValueOnce(nuevo.promesa);
    if (cambio === 'tenant') contexto.tenant = `otro-${numero}`;
    else contexto.session = { access_token: `otra-sesion-${numero}` };
    vista.rerender(<Arbol />);
    abrir();
    expect(lista()).toHaveAttribute('aria-busy', 'true');
    expect(lista()).not.toHaveTextContent('Privado anterior');
    await resolver(viejo, datos('Respuesta tardía privada'));
    expect(lista()).not.toHaveTextContent('Respuesta tardía privada');
    await resolver(nuevo, arranque({ estado: 'ok', dato: datos('Solo del contexto nuevo') }));
    expect(lista()).toHaveTextContent('Solo del contexto nuevo');
    expect(lista()).not.toHaveTextContent('Privado anterior');
  });

  it.each(['tenant', 'sesion'] as const)('el arranque tardío de otro %s tampoco se expone', async (cambio) => {
    const viejo = diferida<Arranque>();
    const nuevo = diferida<Arranque>();
    pedir.mockReturnValueOnce(viejo.promesa).mockReturnValueOnce(nuevo.promesa);
    const vista = render(<Arbol />);
    if (cambio === 'tenant') contexto.tenant = `nuevo-${numero}`;
    else contexto.session = { access_token: `nueva-sesion-${numero}` };
    vista.rerender(<Arbol />);
    abrir();
    await resolver(nuevo, arranque({ estado: 'ok', dato: datos('Correcto') }));
    await resolver(viejo, arranque({ estado: 'ok', dato: datos('Ajeno tardío') }));
    expect(lista()).toHaveTextContent('Correcto');
    expect(lista()).not.toHaveTextContent('Ajeno tardío');
  });

  it('un sondeo que termina fuera de orden no pisa el dato más nuevo', async () => {
    vi.useFakeTimers();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    const viejo = diferida<AvisosDto>();
    pedir.mockReturnValueOnce(viejo.promesa);
    await tick();
    pedir.mockResolvedValueOnce(datos('El más reciente'));
    await tick();
    await resolver(viejo, datos('Viejo'));
    expect(lista()).toHaveTextContent('El más reciente');
    expect(lista()).not.toHaveTextContent('Viejo');
  });

  it('marcar leído falla de forma visible, conserva la lista y el identificador del fallo', async () => {
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    pedir.mockRejectedValueOnce(new ApiError('READ_FAILED', 'No pudimos marcar los avisos.', 500, 'req_read'));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Marcar todo leído' })); });
    expect(lista()).toHaveTextContent('READ_FAILED · req_read');
    expect(lista()).toHaveTextContent('Aviso del negocio A');
  });

  it('un permiso revocado al marcar elimina los avisos privados', async () => {
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    pedir.mockRejectedValueOnce(new ApiError('FORBIDDEN', 'No tienes permiso.', 403, 'req_read'));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Marcar todo leído' })); });
    expect(lista()).toHaveTextContent('No tienes permiso');
    expect(lista()).not.toHaveTextContent('Aviso del negocio A');
    expect(screen.getByLabelText('Avisos', { exact: true })).toBeVisible();
  });

  it.each([500, 403])('el refresco tras marcar tampoco oculta un %s', async (status) => {
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    abrir();
    pedir.mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError(status === 403 ? 'FORBIDDEN' : 'REFRESH_FAILED', 'No se pudo actualizar.', status, 'req_after_read'));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Marcar todo leído' })); });
    expect(lista()).toHaveTextContent(status === 403 ? 'No tienes permiso' : 'REFRESH_FAILED · req_after_read');
    if (status === 403) expect(lista()).not.toHaveTextContent('Aviso del negocio A');
    else expect(lista()).toHaveTextContent('Aviso del negocio A');
  });

  it('Tab alcanza configurar en vacío; Escape devuelve el foco', async () => {
    const usuario = userEvent.setup();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: { items: [], unread: 0 } }));
    await act(async () => { render(<Arbol />); });
    await usuario.tab();
    await usuario.keyboard('{Enter}');
    await usuario.tab();
    expect(screen.getByRole('link', { name: 'Configurar avisos' })).toHaveFocus();
    await usuario.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Avisos' })).toHaveFocus();
  });

  it('Tab y Shift+Tab alcanzan Copiar/Reintentar sin cerrar el fallo', async () => {
    const usuario = userEvent.setup();
    pedir.mockResolvedValueOnce(arranque({ estado: 'falla' }))
      .mockRejectedValue(new ApiError('FALLA', 'No se pudo cargar.', 500, 'req_teclado'));
    await act(async () => { render(<Arbol />); });
    await usuario.tab();
    await usuario.keyboard('{Enter}');
    await usuario.tab();
    expect(screen.getByRole('button', { name: 'Copiar' })).toHaveFocus();
    await usuario.tab();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toHaveFocus();
    await usuario.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Copiar' })).toHaveFocus();
  });

  it('las flechas recorren Marcar y los avisos registrados en el menú', async () => {
    const usuario = userEvent.setup();
    pedir.mockResolvedValueOnce(arranque({ estado: 'ok', dato: datos() }));
    await act(async () => { render(<Arbol />); });
    await usuario.tab();
    await usuario.keyboard('{Enter}');
    const marcar = screen.getByRole('menuitem', { name: 'Marcar todo leído' });
    const aviso = screen.getByRole('menuitem', { name: /Aviso del negocio A/ });
    await waitFor(() => expect(marcar).toHaveFocus());
    await usuario.keyboard('{ArrowDown}');
    await waitFor(() => expect(aviso).toHaveFocus());
    await usuario.keyboard('{ArrowUp}');
    await waitFor(() => expect(marcar).toHaveFocus());
    await usuario.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Avisos, 1 sin leer' })).toHaveFocus();
  });
});
