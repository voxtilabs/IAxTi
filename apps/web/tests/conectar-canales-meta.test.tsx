// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConectarCanalesMeta } from '../components/conectar-canales-meta';
import { ProbarEnvio } from '../components/canales';

const contexto = vi.hoisted(() => ({ tenant: 'negocio-a', session: { access_token: 'sesion-a' }, config: { apiUrl: 'https://api.example.test' } }));
vi.mock('@iaxti/ui/react', async (original) => ({ ...await original<object>(), useSession: () => ({ config: contexto.config, session: contexto.session }) }));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
const opcion = { senderId: 'sender-acreditado', kind: 'instagram', name: 'Tienda ficticia' };
const respuesta = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function pendiente<T>() { let resolver!: (x: T) => void; const promesa = new Promise<T>((r) => { resolver = r; }); return { promesa, resolver }; }
beforeEach(() => { contexto.tenant = 'negocio-a'; contexto.session = { access_token: 'sesion-a' }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('conexiones acreditadas desde Canales (#74)', () => {
  it('muestra carga real, después vacío con comprobación y explicación del paso operador', async () => {
    const pedido = pendiente<Response>(); vi.stubGlobal('fetch', vi.fn(() => pedido.promesa));
    render(<ConectarCanalesMeta onConectado={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Buscando conexiones' })).toBeInTheDocument();
    expect(screen.queryByText('No hay conexiones pendientes')).not.toBeInTheDocument();
    pedido.resolver(respuesta([]));
    expect(await screen.findByText('No hay conexiones pendientes')).toBeInTheDocument();
    expect(screen.getByText(/habilite para tu negocio/)).toBeInTheDocument();
  });
  it.each([403, 500])('clasifica %s, conserva rastro del fallo y solo reintenta lo reintentable', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(respuesta({ code: 'FALLO_74', message: 'Respuesta ficticia', requestId: 'req_74' }, status)); vi.stubGlobal('fetch', fetcher);
    render(<ConectarCanalesMeta onConectado={vi.fn()} />);
    if (status === 403) {
      expect(await screen.findByText(/Necesitas permiso/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText('FALLO_74 · req_74')).toBeInTheDocument();
      fetcher.mockResolvedValue(respuesta([opcion]));
      await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
      expect(await screen.findByRole('button', { name: 'Conectar Instagram' })).toBeInTheDocument();
    }
  });
  it('conecta por teclado sin enviar refs y evita doble petición mientras espera', async () => {
    const guardado = pendiente<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(respuesta([opcion])).mockImplementation(() => guardado.promesa); vi.stubGlobal('fetch', fetcher);
    const conectado = vi.fn(); render(<ConectarCanalesMeta onConectado={conectado} />);
    const boton = await screen.findByRole('button', { name: 'Conectar Instagram' });
    const user = userEvent.setup(); await user.tab(); expect(boton).toHaveFocus();
    await user.keyboard('{Enter}'); await user.keyboard('{Enter}');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ senderId: opcion.senderId, kind: 'instagram' });
    expect(screen.getByRole('button', { name: 'Comprobando…' })).toBeDisabled();
    guardado.resolver(respuesta({ id: 'account-74', kind: 'instagram', name: opcion.name, state: 'active' }, 201));
    await waitFor(() => expect(conectado).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Conectar Instagram' })).not.toBeInTheDocument();
  });
  it('un fallo al conectar conserva opción y rastro para reintentar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(respuesta([opcion])).mockResolvedValue(respuesta({ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Revisa la conexión.', requestId: 'req_conn' }, 400)));
    render(<ConectarCanalesMeta onConectado={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar Instagram' }));
    expect(await screen.findByText('WEBHOOK_NOT_CONFIGURED · req_conn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Conectar Instagram' })).toBeEnabled();
  });
  it.each(['tenant', 'session'] as const)('descarta el alta tardía del %s anterior', async (cambio) => {
    const alta = pendiente<Response>();
    const fetcher = vi.fn().mockResolvedValueOnce(respuesta([opcion])).mockImplementationOnce(() => alta.promesa).mockResolvedValue(respuesta([])); vi.stubGlobal('fetch', fetcher);
    const conectado = vi.fn(); const view = render(<ConectarCanalesMeta onConectado={conectado} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conectar Instagram' }));
    if (cambio === 'tenant') contexto.tenant = 'negocio-b'; else contexto.session = { access_token: 'sesion-b' };
    view.rerender(<ConectarCanalesMeta onConectado={conectado} />);
    await screen.findByText('No hay conexiones pendientes');
    await act(async () => alta.resolver(respuesta({ id: 'cuenta-vieja', kind: 'instagram', state: 'active' }, 201)));
    expect(conectado).not.toHaveBeenCalled(); expect(screen.queryByText(opcion.name)).not.toBeInTheDocument();
  });
  it('la prueba de envío pide ID de canal, lo mantiene intacto y muestra el rechazo con rastro', async () => {
    const fetcher = vi.fn().mockResolvedValue(respuesta({ code: 'PROVIDER_UNAVAILABLE', message: 'No salió.', requestId: 'req_send' }, 503)); vi.stubGlobal('fetch', fetcher);
    render(<ProbarEnvio accountId="account-74" kind="messenger" />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Identificador del contacto para la prueba' }), '24025631120151183');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar prueba' }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ telefono: '24025631120151183' });
    expect(await screen.findByText('PROVIDER_UNAVAILABLE · req_send')).toBeInTheDocument();
  });
});
