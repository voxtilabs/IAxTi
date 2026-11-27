// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * El rework de /contactos (#1395).
 *
 * Lo que se prueba es lo que hace quien administra su cartera: crear un
 * contacto a mano (y toparse con el que ya existía), filtrar por canal y
 * permiso sin perder la primera página, y abrir la ficha de alguien con su
 * conversación más reciente a un clic. Las fechas relativas y el teléfono
 * legible se prueban con un «ahora» fijo: una prueba que mide el reloj de la
 * máquina pasa o se cae según cuándo se corra.
 */
const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a',
  config: { apiUrl: 'http://api.local', env: 'staging' },
  session: { access_token: 'sesion-a' },
  contacts: vi.fn(),
  tags: vi.fn(),
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
vi.mock('@iaxti/sdk', async (original) => ({
  ...(await original<typeof import('@iaxti/sdk')>()),
  // La lista habla por el SDK; el resto de sus rutas no entra en estas
  // pruebas, así que se responden vacías y en silencio.
  crmClient: () => ({
    contacts: contexto.contacts as never,
    deals: (async () => ({ items: [], nextCursor: null })) as never,
    tags: contexto.tags as never,
    tag: (async () => ({ requested: 0, changed: 0 })) as never,
  }),
}));
import { apiFetch, ApiError } from '../lib/api';
import { Contactos } from '../components/crm/contactos';
import { FichaContacto } from '../components/crm/ficha-contacto';
import { HistoriaConversaciones } from '../components/crm/historia-conversaciones';
import { actividadRelativa } from '../components/crm/ultima-actividad';
import { telefonoLegible } from '../lib/telefono';
import type { ConversacionItem, FichaContacto as Ficha } from '../lib/api';

const pedir = vi.mocked(apiFetch);
/* Radix usa APIs de puntero que jsdom no trae; sin esto el Select y el menú
   caen con `hasPointerCapture is not a function`, que no se parece a su causa. */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};
/* Y el DataTable pregunta por el ancho de la pantalla; jsdom tampoco lo trae
   y el efecto de montaje tumba la corrida aunque la prueba pase. */
window.matchMedia = ((consulta: string) => ({
  matches: false, media: consulta, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as typeof window.matchMedia;

const ANA = {
  id: 'c1', phone: '+56912345678', rut: '12.345.678-5', lastActivityAt: '2026-11-26T12:00:00Z',
  name: 'Ana Pérez', email: 'ana@ejemplo.cl', origin: 'whatsapp', optedOutAt: null, permiso: 'escribio_primero',
};
const JUAN = {
  id: 'c2', phone: '+56221234567', rut: null, lastActivityAt: '2026-11-20T12:00:00Z',
  name: 'Juan Soto', email: null, origin: 'manual', optedOutAt: null, permiso: 'sin_permiso',
};

function servirLista(items = [ANA, JUAN], nextCursor: string | null = null) {
  contexto.contacts.mockReset();
  contexto.contacts.mockResolvedValue({ items, nextCursor });
  contexto.tags.mockReset();
  contexto.tags.mockResolvedValue([]);
}

/** Abre un Select de Radix y elige una opción por su nombre. */
async function elegir(combobox: string, opcion: string) {
  const usuario = userEvent.setup();
  await usuario.click(screen.getByRole('combobox', { name: combobox }));
  const lista = await screen.findByRole('listbox');
  await usuario.click(within(lista).getByRole('option', { name: opcion }));
}

/** Llenar un campo de un golpe: `userEvent.type` teclea letra por letra y,
 * bajo la carga de toda la suite corriendo en paralelo, eso solo consume el
 * tiempo de la prueba. */
function escribir(campo: HTMLElement, valor: string) {
  fireEvent.change(campo, { target: { value: valor } });
}

beforeEach(() => {
  vi.clearAllMocks();
  pedir.mockReset();
  servirLista();
});

describe('la lista de contactos', () => {
  it('«Nuevo contacto» es el único primario, y el menú trae las tres opciones', async () => {
    render(<Contactos />);
    await screen.findByText('Ana Pérez');
    const primarios = document.querySelectorAll('button[data-variant="primario"]');
    expect(primarios).toHaveLength(1);
    expect(primarios[0]!.textContent).toBe('Nuevo contacto');
    // El menú es secundario, no otro primario que compita.
    expect(screen.getByRole('button', { name: 'Importar o exportar' }).getAttribute('data-variant')).toBe('secundario');
    await userEvent.click(screen.getByRole('button', { name: 'Importar o exportar' }));
    const menu = await screen.findByRole('menu');
    // Radix le pone role menuitem también al enlace: lo que lo distingue es
    // que navega, y eso se ve en el href.
    const importar = within(menu).getByRole('menuitem', { name: 'Importar desde una planilla' });
    expect(importar.tagName).toBe('A');
    expect(importar.getAttribute('href')).toBe('/contactos/importar');
    expect(within(menu).getByRole('menuitem', { name: 'Exportar a Excel' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Exportar en CSV' })).toBeTruthy();
  }, 15000);

  it('crear un contacto manda el POST con su llave de idempotencia y recarga la lista', async () => {
    pedir.mockImplementation(async (_c, _s, _t, ruta: string) => {
      if (ruta === '/contacts') return { id: 'c9', name: 'Ana Pérez' } as never;
      return {} as never;
    });
    render(<Contactos />);
    await screen.findByText('Ana Pérez');
    const antes = contexto.contacts.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo contacto' }));
    const dialogo = await screen.findByRole('dialog');
    escribir(within(dialogo).getByRole('textbox', { name: 'Teléfono' }), '+56987654321');
    escribir(within(dialogo).getByRole('textbox', { name: 'Nombre' }), 'Ana Pérez');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Agregar contacto' }));
    await waitFor(() => expect(contexto.contacts.mock.calls.length).toBeGreaterThan(antes));
    const post = pedir.mock.calls.find((c) => c[3] === '/contacts')!;
    const init = post[4] as RequestInit;
    expect(init.method).toBe('POST');
    const llave = (init.headers as Record<string, string>)['Idempotency-Key'];
    expect(llave).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(init.body))).toEqual({
      phone: '+56987654321',
      name: 'Ana Pérez',
    });
    // El diálogo se cerró y quedó creado: el aviso de éxito es un toast de
    // sonner, que sin su Toaster no deja rastro en el DOM — lo que sí se
    // prueba es el cierre y la recarga de arriba.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }, 15000);

  it('un teléfono que ya estaba ofrece ir a ver ese contacto', async () => {
    pedir.mockImplementation(async (_c, _s, _t, ruta: string) => {
      if (ruta === '/contacts') {
        throw new ApiError('CONTACT_EXISTS', 'Ese teléfono ya está en tu cartera.', 409, 'req_1', [{ contactId: 'c7' }]);
      }
      return {} as never;
    });
    render(<Contactos />);
    await screen.findByText('Ana Pérez');
    await userEvent.click(screen.getByRole('button', { name: 'Nuevo contacto' }));
    const dialogo = await screen.findByRole('dialog');
    escribir(within(dialogo).getByRole('textbox', { name: 'Teléfono' }), '+56912345678');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Agregar contacto' }));
    expect(await within(dialogo).findByText('Ese teléfono ya está en tu cartera.')).toBeTruthy();
    expect(within(dialogo).getByRole('link', { name: 'Ver el contacto' }).getAttribute('href')).toBe('/contactos/c7');
    // El 409 no es un rechazo: el diálogo sigue abierto para corregir.
    expect(screen.getByRole('dialog')).toBeTruthy();
  }, 15000);

  it('filtrar por permiso y canal pide la lista filtrada y vuelve a la primera página', async () => {
    servirLista([ANA], 'cursor-2');
    render(<Contactos />);
    await screen.findByText('Ana Pérez');
    // Página 2: el cursor viaja.
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
    await waitFor(() => expect(contexto.contacts.mock.calls.at(-1)![0].get('cursor')).toBe('cursor-2'));
    await elegir('Permiso', 'Se le puede escribir');
    await waitFor(() => expect(contexto.contacts.mock.calls.at(-1)![0].get('filter[permiso]')).toBe('puede'));
    // Volver a la primera página: el cursor se fue.
    expect(contexto.contacts.mock.calls.at(-1)![0].get('cursor')).toBeNull();
    await elegir('Canal', 'WhatsApp');
    await waitFor(() => expect(contexto.contacts.mock.calls.at(-1)![0].get('filter[origen]')).toBe('whatsapp'));
  }, 15000);

  it('la columna de canal muestra el logo de la marca y la etiqueta de cada origen', async () => {
    const { container } = render(<Contactos />);
    await screen.findByText('Ana Pérez');
    expect(container.querySelector('img[src="/marca/whatsapp-icon.svg"]')).toBeTruthy();
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('Agregado a mano')).toBeTruthy();
    // El teléfono se lee separado y el RUT dejó de ocupar columna.
    expect(screen.getByText('+56 9 1234 5678')).toBeTruthy();
    expect(screen.getByText('+56 2 2123 4567')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'RUT' })).toBeNull();
  });
});

describe('el teléfono legible', () => {
  it('separa los chilenos y deja el resto tal cual', () => {
    expect(telefonoLegible('+56912345678')).toBe('+56 9 1234 5678');
    expect(telefonoLegible('+56221234567')).toBe('+56 2 2123 4567');
    expect(telefonoLegible('+14155550123')).toBe('+14155550123');
    expect(telefonoLegible('+5691234567')).toBe('+5691234567');
    expect(telefonoLegible(null)).toBe('—');
  });
});

describe('la última actividad relativa', () => {
  // Fijos y en hora local: nada de cadenas «solo fecha», que se corren un día
  // según la zona con que se corra la suite.
  const AHORA = new Date(2026, 10, 26, 18, 0);
  const hace = (dias: number) => new Date(2026, 10, 26 - dias, 10, 0).toISOString();

  it('dice hoy, ayer, días y semanas, y pasa a fecha pasados 30 días', () => {
    expect(actividadRelativa(hace(0), AHORA)).toBe('hoy');
    expect(actividadRelativa(hace(1), AHORA)).toBe('ayer');
    expect(actividadRelativa(hace(3), AHORA)).toBe('hace 3 días');
    expect(actividadRelativa(hace(7), AHORA)).toBe('hace 1 semana');
    expect(actividadRelativa(hace(14), AHORA)).toBe('hace 2 semanas');
    expect(actividadRelativa(hace(31), AHORA)).toBe(new Date(2026, 10, 26 - 31).toLocaleDateString('es-CL'));
  });
});

describe('la ficha del contacto', () => {
  const fichaDeAna: Ficha = {
    contact: {
      id: 'c1', phone: '+56912345678', name: 'Ana Pérez', email: 'ana@ejemplo.cl', rut: '12.345.678-5',
      origin: 'whatsapp', opt_in_at: null, opted_out_at: null, last_activity_at: '2026-11-26T10:00:00Z',
      created_at: '2026-01-15T12:00:00Z', custom: null, company_id: null, company_name: null,
      permiso: 'escribio_primero',
    },
    deals: [],
    activities: [],
  };

  const conversaciones: ConversacionItem[] = [
    {
      id: 'conv-2', contactId: 'c1', contactName: 'Ana Pérez', contactPhone: '+56912345678',
      channel: 'simulador', state: 'open', ownerId: null, lastInboundAt: new Date(2026, 10, 25, 9, 0).toISOString(),
      lastMessageAt: new Date(2026, 10, 25, 10, 30).toISOString(), unansweredSeconds: null, snoozedUntil: null, priority: 'normal',
    },
    {
      id: 'conv-1', contactId: 'c1', contactName: 'Ana Pérez', contactPhone: '+56912345678',
      channel: 'whatsapp', state: 'resolved', ownerId: null, lastInboundAt: new Date(2026, 10, 20, 10, 0).toISOString(),
      lastMessageAt: new Date(2026, 10, 20, 10, 0).toISOString(), unansweredSeconds: null, snoozedUntil: null, priority: 'normal',
    },
  ];

  beforeEach(() => {
    pedir.mockImplementation(async (_c, _s, _t, ruta: string) => {
      if (ruta === '/contacts/c1') return fichaDeAna as never;
      if (ruta === '/tags/contacto/c1') return [] as never;
      return {} as never;
    });
  });

  it('«Abrir conversación» lleva a la más reciente; sin conversaciones no aparece', async () => {
    const { rerender } = render(<FichaContacto contactId="c1" conversaciones={conversaciones} />);
    const abrir = await screen.findByRole('link', { name: 'Abrir conversación' });
    expect(abrir.getAttribute('href')).toBe('/bandeja?conversationId=conv-2');
    expect(screen.getByText('Escribió primero')).toBeTruthy();
    expect(screen.getByText('+56 9 1234 5678')).toBeTruthy();
    rerender(<FichaContacto contactId="c1" conversaciones={[]} />);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Abrir conversación' })).toBeNull());
    // Sin conversación no hay primario: «Corregir los datos» es secundario.
    expect(screen.getByRole('button', { name: 'Corregir los datos' }).getAttribute('data-variant')).toBe('secundario');
  });

  it('el formulario de actividades queda detrás de «Agregar actividad»', async () => {
    render(<FichaContacto contactId="c1" conversaciones={conversaciones} />);
    await screen.findByRole('link', { name: 'Abrir conversación' });
    expect(screen.queryByRole('textbox', { name: 'Título de la actividad' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Agregar actividad' }));
    expect(screen.getByRole('textbox', { name: 'Título de la actividad' })).toBeTruthy();
  });

  it('los derechos del titular quedan plegados dentro de un details cerrado', async () => {
    render(<FichaContacto contactId="c1" conversaciones={conversaciones} />);
    await screen.findByRole('link', { name: 'Abrir conversación' });
    const detalle = document.querySelector('details')!;
    expect(detalle.querySelector('summary')!.textContent).toBe('Privacidad y datos de esta persona');
    expect(detalle.open).toBe(false);
    expect(detalle.textContent).toContain('Derechos de esta persona');
  });

  it('cada conversación de la historia enlaza a la suya y nombra el canal de persona', () => {
    render(<HistoriaConversaciones items={conversaciones} />);
    const enlaces = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(enlaces).toEqual(['/bandeja?conversationId=conv-2', '/bandeja?conversationId=conv-1']);
    expect(screen.getByText('Número de demostración')).toBeTruthy();
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    // La fecha va sin segundos.
    expect(screen.getByText('25-11-2026, 10:30')).toBeTruthy();
  });

  it('la historia sin conversaciones lo dice, y sin datos aún no se dibuja', () => {
    const { rerender } = render(<HistoriaConversaciones items={[]} />);
    expect(screen.getByText('Sin conversaciones todavía.')).toBeTruthy();
    rerender(<HistoriaConversaciones items={null} />);
    expect(screen.queryByText('Sin conversaciones todavía.')).toBeNull();
  });
});
