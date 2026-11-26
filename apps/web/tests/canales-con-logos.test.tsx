// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Los canales como grilla con su logo (#1391).
 *
 * Lo que se prueba es lo que ve el dueño: qué tiene conectado, qué le falta y
 * dónde se conecta. Y que lo que ya funcionaba —diagnóstico, prueba de envío,
 * desconectar— siga ahí, ahora dentro del detalle del canal.
 *
 * Y el flujo de conectar WhatsApp desde la app (#1393): el enlace de Meta con
 * su llave de idempotencia, los números ya autorizados, el alta del elegido y
 * la vuelta de Meta reabriendo el diálogo.
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
import { Avisos } from '@iaxti/ui/react';
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

/**
 * Responde por ruta. `rutas` cubre lo que no son los canales ni los widgets:
 * los números para conectar, el enlace de Meta y el alta — un valor directo, o
 * una función para los casos que tienen que fallar.
 */
function servir(canales: unknown[], widgets: unknown[] = [], rutas: Record<string, unknown> = {}) {
  pedir.mockImplementation(async (_c, _s, _t, ruta: string) => {
    if (ruta === '/channels') return canales as never;
    if (ruta === '/webchat/widgets') return widgets as never;
    if (ruta === '/channels/whatsapp/numeros' && !(ruta in rutas)) return [] as never;
    if (ruta in rutas) {
      const valor: unknown = rutas[ruta];
      return (typeof valor === 'function' ? (valor as () => unknown)() : valor) as never;
    }
    return {} as never;
  });
}

/**
 * jsdom no deja espiar `location.assign` —sus propiedades son
 * inconfigurables— pero la `window` de Vitest sí deja reemplazar
 * `window.location` entero. Se cambia por una copia con el `assign` de
 * mentira y se devuelve cómo poner el original de vuelta.
 */
function remplazarLocation(assign: (url: string) => void) {
  const original = Object.getOwnPropertyDescriptor(window, 'location')!;
  Object.defineProperty(window, 'location', {
    value: {
      href: window.location.href,
      origin: window.location.origin,
      search: window.location.search,
      assign,
      replace: () => {},
      reload: () => {},
    },
    configurable: true,
    writable: true,
  });
  return () => Object.defineProperty(window, 'location', original);
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

  it('un alta que se cortó a mitad dice «Sin terminar» y ofrece terminarla', async () => {
    const aMedias = { ...WHATSAPP, state: 'connecting', numbers: [] };
    servir([aMedias], [], {
      '/channels/whatsapp/numeros': [{ cuenta: 'acc_1', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: false }],
    });
    render(<Canales />);
    const wa = (await screen.findByText('WhatsApp')).closest('li')!;
    expect(within(wa).getByText('Sin terminar')).toBeTruthy();
    fireEvent.click(within(wa).getByRole('button', { name: 'Conectar' }));
    const detalle = await screen.findByRole('dialog');
    expect(await within(detalle).findByRole('button', { name: 'Conectar este número' })).toBeTruthy();
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

describe('conectar WhatsApp desde la app', () => {
  /** Abre el diálogo de WhatsApp partiendo de la grilla sin nada conectado. */
  async function abrirDialogoDeWhatsApp() {
    const wa = (await screen.findByText('WhatsApp')).closest('li')!;
    fireEvent.click(within(wa).getByRole('button', { name: 'Conectar' }));
    return screen.findByRole('dialog');
  }

  it('sin números autorizados, «Conectar con Meta» pide el enlace y se va a Meta', async () => {
    servir([], [], {
      '/channels/whatsapp/numeros': [],
      '/channels/whatsapp/enlace': { url: 'https://zernio.test/embed/alta?perfil=p1' },
    });
    const asignar = vi.fn();
    const restaurar = remplazarLocation(asignar);
    try {
      render(<Canales />);
      const detalle = await abrirDialogoDeWhatsApp();
      fireEvent.click(await within(detalle).findByRole('button', { name: 'Conectar con Meta' }));
      await waitFor(() => expect(asignar).toHaveBeenCalledWith('https://zernio.test/embed/alta?perfil=p1'));
      const enlace = pedir.mock.calls.find((c) => c[3] === '/channels/whatsapp/enlace')!;
      const init = enlace[4]!;
      expect(init).toMatchObject({ method: 'POST' });
      expect(init.body).toBeUndefined();
      // La cabecera existe y es un UUID: la API exige idempotencia en el alta.
      expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      restaurar();
    }
  });

  it('con un número autorizado, «Conectar este número» da de alta la cuenta y recarga', async () => {
    servir([], [], {
      '/channels/whatsapp/numeros': [
        { cuenta: 'cuenta-z1', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: false },
      ],
      '/channels/whatsapp/conectar': { id: 'wa9', name: 'WhatsApp', state: 'connecting', renovada: false },
    });
    render(<Canales />);
    const detalle = await abrirDialogoDeWhatsApp();
    fireEvent.click(await within(detalle).findByRole('button', { name: 'Conectar este número' }));
    // La recarga es la señal de que el alta salió bien.
    await waitFor(() => {
      expect(pedir.mock.calls.filter((c) => c[3] === '/channels').length).toBe(2);
    });
    const alta = pedir.mock.calls.find((c) => c[3] === '/channels/whatsapp/conectar')!;
    const altaInit = alta[4]!;
    expect(JSON.parse(altaInit.body as string)).toEqual({ cuenta: 'cuenta-z1' });
    expect(new Headers(altaInit.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('un número que ya está conectado no aparece en la lista', async () => {
    servir([], [], {
      '/channels/whatsapp/numeros': [
        { cuenta: 'c1', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: true },
      ],
    });
    render(<Canales />);
    const detalle = await abrirDialogoDeWhatsApp();
    await within(detalle).findByText('Conecta tu número de WhatsApp Business');
    expect(within(detalle).queryByText('+56 9 2201 3949')).toBeNull();
    expect(within(detalle).queryByRole('button', { name: 'Conectar este número' })).toBeNull();
  });

  it('si conectar falla, el motivo queda en pantalla y no se recarga como si hubiera conectado', async () => {
    servir([], [], {
      '/channels/whatsapp/numeros': [
        { cuenta: 'c1', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: false },
      ],
      '/channels/whatsapp/conectar': () => {
        throw new Error('Tu plan permite 1 número de WhatsApp. Sube de plan para conectar otro.');
      },
    });
    // El aviso va por toast: sin el Toaster montado, el texto no llega al DOM.
    render(
      <>
        <Avisos />
        <Canales />
      </>
    );
    const detalle = await abrirDialogoDeWhatsApp();
    fireEvent.click(await within(detalle).findByRole('button', { name: 'Conectar este número' }));
    expect(await screen.findByText('Tu plan permite 1 número de WhatsApp. Sube de plan para conectar otro.')).toBeTruthy();
    // Ni recarga ni apagado del botón: el fallo se puede reintentar.
    expect(pedir.mock.calls.filter((c) => c[3] === '/channels').length).toBe(1);
    expect(within(detalle).getByRole('button', { name: 'Conectar este número' })).toBeTruthy();
  });

  it('en el diálogo hay a lo más un botón con variante primaria', async () => {
    servir([], [], {
      '/channels/whatsapp/numeros': [
        { cuenta: 'c1', nombre: '+56 9 2201 3949', pideReconectar: false, yaConectado: false },
        { cuenta: 'c2', nombre: '+56 9 2202 1111', pideReconectar: true, yaConectado: false },
      ],
    });
    render(<Canales />);
    const detalle = await abrirDialogoDeWhatsApp();
    expect((await within(detalle).findAllByRole('button', { name: 'Conectar este número' })).length).toBe(2);
    expect(within(detalle).getByText('Pide reconectar en Meta')).toBeTruthy();
    // El primario es el primero de la lista; «Conectar otro número» acompaña.
    const primarios = detalle.querySelectorAll('button[data-variant="primario"]');
    expect(primarios.length).toBe(1);
    expect(primarios[0].textContent).toBe('Conectar este número');
  });

  it('al volver de Meta (?whatsapp=volvio) el diálogo se abre solo y el parámetro se limpia', async () => {
    window.history.replaceState(null, '', '/ajustes/canales?whatsapp=volvio');
    servir([], [], { '/channels/whatsapp/numeros': [] });
    try {
      render(<Canales />);
      // Se abre sin que nadie lo toque, una vez que los canales cargaron.
      const detalle = await screen.findByRole('dialog');
      await within(detalle).findByText('Conecta tu número de WhatsApp Business');
      // Y el parámetro ya cumplió: un F5 no vuelve a abrir el diálogo.
      expect(window.location.search).toBe('');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
