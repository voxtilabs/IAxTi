// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Tu asistente» la primera vez (#1401), montado y no leído (#564).
 *
 * El recorrido medido: una dueña se registra, entra a «Tu asistente» y lo
 * primero que lee son sugerencias que suponen que ya tiene uno, un saludo
 * que habla de embudos, pasos que dicen `agents.objetivos` y una propuesta
 * cuya etiqueta es la ficha técnica de la herramienta. Acá se monta la
 * conversación entera —proveedor, hilo y UI— y se lee lo que la dueña lee.
 */

const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a',
  config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
  /** Lo que responde `GET /agents`: si el negocio tiene asistentes. */
  agentes: [] as Array<{ id: string; name: string; active: boolean }>,
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({
  useSelectedTenant: () => contexto.tenant,
  selectedTenant: () => contexto.tenant,
}));
/* La pantalla del asistente es la que conversa: `/ajustes/ia`. */
vi.mock('next/navigation', () => ({ usePathname: () => '/ajustes/ia' }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { Conversacion } from '../components/agente/conversacion';
import { ProveedorAgente } from '../components/agente/estado';

const pedir = vi.mocked(apiFetch);

/* Radix usa APIs de puntero que jsdom no trae. */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

const UN_ASISTENTE = [{ id: 'a1', name: 'Agenda Pelu Ñuñoa', active: true }];

/** La respuesta que armó el Agente General para «ármame un asistente». */
const RESPUESTA_QUE_PROPONE = {
  texto: 'Con esto ya puedo armarte el asistente. Revisa si está bien y aprieta «Hazlo».',
  pasos: [
    { herramienta: 'agents.objetivos', modulo: 'agents', metodo: 'GET', ruta: '/v1/agents/objetivos', ok: true },
    { herramienta: 'agents.create', modulo: 'agents', metodo: 'POST', ruta: '/v1/agents', ok: true },
    // Una herramienta sin nombre de persona: no se dibuja.
    { herramienta: 'que_le_falta_al_negocio', modulo: null, metodo: 'GET', ruta: '(varios módulos)', ok: true },
  ],
  propuesta: {
    herramienta: 'agents.create',
    descripcion: 'Crea un asistente (proveedor y modelo configurables)',
    metodo: 'POST',
    ruta: '/v1/agents',
    permiso: 'agents.configure',
    argumentos: {
      name: 'Precios Peluquería Ñuñoa',
      personality: 'Tono cálido y breve.',
      defaultMode: 'assist',
      language: 'es-CL',
    },
  },
  truncada: false,
  vista: null,
};

function servir() {
  pedir.mockImplementation(async (_c, _s, _t, path: string, init?: RequestInit) => {
    if (path === '/agents') return contexto.agentes as never;
    if (path === '/agents/diagnostico') return { problema: null, pasos: [] } as never;
    if (path.includes('sugerencias')) return { sugerencias: [] } as never;
    if (path === '/agente-general' && init?.method === 'POST') return RESPUESTA_QUE_PROPONE as never;
    if (path === '/agente-general/aplicar') return {} as never;
    if (path === '/agente-general/hilos') return { id: 'h1' } as never;
    return {} as never;
  });
}

beforeEach(() => {
  pedir.mockReset();
  contexto.agentes = [];
  servir();
});

describe('el saludo de la primera vez', () => {
  it('sin asistentes habla del asistente, no de embudos ni reglas', async () => {
    contexto.agentes = [];
    render(
      <ProveedorAgente>
        <Conversacion />
      </ProveedorAgente>,
    );
    expect(
      await screen.findByText(
        'Cuéntame a qué se dedica tu negocio y te armo un asistente que conteste por ti. Antes de que hable con alguien, lo apruebas.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Dime qué necesitas en tus palabras/)).not.toBeInTheDocument();
  });

  it('con asistentes, el saludo de siempre', async () => {
    contexto.agentes = UN_ASISTENTE;
    render(
      <ProveedorAgente>
        <Conversacion />
      </ProveedorAgente>,
    );
    expect(await screen.findByText(/Dime qué necesitas en tus palabras/)).toBeInTheDocument();
    expect(screen.queryByText(/te armo un asistente/)).not.toBeInTheDocument();
  });
});

describe('la respuesta que ve la dueña', () => {
  /**
   * La vuelta entera en una prueba: el hilo vive FUERA de React (módulo de
   * `estado.tsx`), así que partir el flujo en pruebas separadas dejaría a la
   * segunda dependiendo de que la primera corriera antes — y en el orden
   * equivocado, en verde prestado.
   */
  it('pasos sin jerga, propuesta con nombre de persona y qué sigue tras «Hecho»', async () => {
    const usuario = userEvent.setup();
    render(
      <ProveedorAgente>
        <Conversacion />
      </ProveedorAgente>,
    );
    const campo = await screen.findByLabelText('Pídele algo a IAxTi');
    await usuario.type(campo, 'Ármame un asistente que conteste mi WhatsApp');
    await usuario.click(screen.getByRole('button', { name: 'Pedir' }));

    // La respuesta llegó: los pasos, arriba de la prosa.
    expect(await screen.findByText('Revisé qué puede hacer un asistente')).toBeInTheDocument();
    expect(screen.getByText('Preparé tu asistente')).toBeInTheDocument();
    // El nombre técnico crudo no aparece en ningún rincón de la pantalla —
    // ni el paso, ni el módulo, ni la etiqueta de la propuesta.
    expect(document.body.textContent).not.toContain('agents.');
    // La herramienta que no tiene nombre de persona no se dibuja.
    expect(screen.queryByText('que_le_falta_al_negocio')).not.toBeInTheDocument();

    // La etiqueta de la propuesta: qué ES, no la ficha de la herramienta.
    expect(screen.getByText('Crear tu asistente')).toBeInTheDocument();
    expect(screen.queryByText('Crea un asistente (proveedor y modelo configurables)')).not.toBeInTheDocument();

    // Tras aplicar con éxito: qué sigue, con enlace a Canales.
    await usuario.click(screen.getByRole('button', { name: 'Hazlo' }));
    await waitFor(() => expect(screen.getByText('Hecho')).toBeInTheDocument());
    expect(screen.getByText(/Siguiente: conecta tu WhatsApp para que empiece a contestar/)).toBeInTheDocument();
    const enlace = screen.getByRole('link', { name: 'Conectar WhatsApp' });
    expect(enlace).toHaveAttribute('href', '/ajustes/canales');
  });
});
