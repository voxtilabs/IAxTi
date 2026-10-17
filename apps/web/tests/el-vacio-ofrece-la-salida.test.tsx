// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Un estado vacío tiene que ofrecer la salida, no solo describir el vacío
 * (#588).
 *
 * Las tres pantallas de este archivo ya explicaban bien para qué sirve lo que
 * falta —las etiquetas, las empresas, los atajos— y las tres terminaban en
 * nada: un panel de texto, o una línea gris. El formulario está arriba en los
 * tres casos, pero quien llega a una pantalla vacía no tiene por qué deducir
 * que lo que busca está más arriba de lo que está leyendo.
 *
 * Lo que se comprueba acá es el clic: que el botón del vacío deje el cursor en
 * el campo donde se empieza. Sin esto, «usa EstadoVacio» sería una afirmación
 * sobre el import y no sobre lo que le pasa a quien usa la pantalla.
 *
 * Y el de empresas comprueba la otra mitad: buscar sin resultados y no tener
 * nada son dos callejones distintos, y la salida del primero es borrar la
 * búsqueda, no crear una empresa.
 */
const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a',
  config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => contexto,
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Etiquetas } from '../components/etiquetas';
import { Empresas } from '../components/empresas';
import { AtajosDeRespuesta } from '../components/atajos-de-respuesta';

const pedir = vi.mocked(apiFetch);
afterEach(() => pedir.mockReset());

describe('el vacío ofrece la salida', () => {
  it('etiquetas: el botón deja el cursor en el nombre', async () => {
    pedir.mockResolvedValue([] as never);
    render(<Etiquetas />);
    await waitFor(() => expect(screen.getByText('Todavía no hay etiquetas')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Crear la primera' }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Cliente frecuente'));
  });

  it('atajos: el botón deja el cursor en el nombre del atajo', async () => {
    pedir.mockResolvedValue([] as never);
    render(<AtajosDeRespuesta />);
    await waitFor(() => expect(screen.getByText('Todavía no hay atajos')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Escribir el primero' }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText('horario'));
  });

  it('empresas: sin ninguna, la salida es crear', async () => {
    pedir.mockResolvedValue([] as never);
    render(<Empresas />);
    await waitFor(() => expect(screen.getByText('Todavía no hay empresas')).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Crear la primera' }));
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Constructora del Sur SpA'));
  });

  it('empresas: con búsqueda sin resultados, la salida es BORRAR la búsqueda', async () => {
    pedir.mockResolvedValue([] as never);
    render(<Empresas />);
    const busqueda = await screen.findByPlaceholderText('Buscar por nombre o RUT');
    await userEvent.type(busqueda, 'constructora');
    await waitFor(() => expect(screen.getByText('Ninguna empresa con eso')).toBeDefined());
    // Y NO ofrece crear: eso mandaría a resolver el problema equivocado.
    expect(screen.queryByRole('button', { name: 'Crear la primera' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Borrar la búsqueda' }));
    await waitFor(() => expect((busqueda as HTMLInputElement).value).toBe(''));
  });
});
