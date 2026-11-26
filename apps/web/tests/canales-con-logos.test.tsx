// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Los canales como grilla con su logo (#1391).
 *
 * Lo que se prueba es lo que ve el dueño: qué tiene conectado, qué le falta y
 * dónde se conecta. Y que lo que ya funcionaba —diagnóstico, prueba de envío,
 * desconectar— siga ahí, ahora dentro del detalle del canal.
 */
const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a',
  config: { apiUrl: 'http://api.local', env: 'staging' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Canales } from '../components/canales';

const pedir = vi.mocked(apiFetch);
Element.prototype.hasPointerCapture = () => false;
Element.prototype.scrollIntoView = () => {};

const WHATSAPP = {
  id: 'wa1',
  kind: 'whatsapp',
  name: 'WhatsApp de la peluquería',
  state: 'active',
  numbers: [{ id: 'n1', displayPhone: '+56 9 2201 3949', phoneNumberId: 'p1', quality: 'green', messagingLimit: null }],
};
const SIMULADOR = { id: 's1', kind: 'simulator', name: 'Número de demostración', state: 'active', numbers: [] };

function servir(canales: unknown[], widgets: unknown[] = []) {
  pedir.mockImplementation(async (_c, _s, _t, ruta: string) => {
    if (ruta === '/channels') return canales as never;
    if (ruta === '/webchat/widgets') return widgets as never;
    return {} as never;
  });
}

beforeEach(() => pedir.mockReset());

describe('la grilla de canales', () => {
  it('una tarjeta por canal, con el logo oficial de cada marca', async () => {
    servir([]);
    const { container } = render(<Canales />);
    for (const nombre of ['WhatsApp', 'Instagram', 'Messenger', 'Chat del sitio']) {
      expect(await screen.findByText(nombre)).toBeTruthy();
    }
    const logos = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(logos).toEqual(expect.arrayContaining(['/marca/whatsapp-icon.svg', '/marca/instagram-icon.svg', '/marca/messenger-icon.svg']));
  });

  it('lo conectado dice su número y ofrece administrar; lo que falta ofrece conectar', async () => {
    servir([WHATSAPP]);
    render(<Canales />);
    const wa = (await screen.findByText('WhatsApp')).closest('li')!;
    expect(within(wa).getByText('+56 9 2201 3949')).toBeTruthy();
    expect(within(wa).getByRole('button', { name: 'Administrar' })).toBeTruthy();
    const chat = screen.getByText('Chat del sitio').closest('li')!;
    expect(within(chat).getByText('Sin conectar')).toBeTruthy();
    expect(within(chat).getByRole('button', { name: 'Conectar' })).toBeTruthy();
  });

  it('Instagram y Messenger dicen «Próximamente» y no ofrecen un botón que no lleva a nada', async () => {
    servir([]);
    render(<Canales />);
    const ig = (await screen.findByText('Instagram')).closest('li')!;
    expect(within(ig).getByText('Próximamente')).toBeTruthy();
    expect(within(ig).queryByRole('button')).toBeNull();
  });

  it('el detalle de WhatsApp conserva el diagnóstico, la prueba de envío y desconectar', async () => {
    servir([WHATSAPP]);
    render(<Canales />);
    fireEvent.click(await screen.findByRole('button', { name: 'Administrar' }));
    const detalle = await screen.findByRole('dialog');
    expect(within(detalle).getByRole('button', { name: '¿Por qué no llegan los mensajes?' })).toBeTruthy();
    expect(within(detalle).getByLabelText('Número para la prueba')).toBeTruthy();
    expect(within(detalle).getByRole('button', { name: 'Desconectar canal' })).toBeTruthy();
  });

  it('conectar WhatsApp no finge un flujo: dice cómo se conecta hoy', async () => {
    servir([]);
    render(<Canales />);
    const wa = (await screen.findByText('WhatsApp')).closest('li')!;
    fireEvent.click(within(wa).getByRole('button', { name: 'Conectar' }));
    const detalle = await screen.findByRole('dialog');
    expect(within(detalle).getByRole('link', { name: 'Pedir la conexión' }).getAttribute('href')).toMatch(/^mailto:/);
  });

  it('el simulador ya no está en la vista principal: queda detrás de su enlace', async () => {
    servir([WHATSAPP, SIMULADOR]);
    render(<Canales />);
    await screen.findByText('WhatsApp');
    expect(screen.queryByText('Probar sin número real')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir el simulador' }));
    await waitFor(() => expect(screen.getByText('Probar sin número real')).toBeTruthy());
  });
});
