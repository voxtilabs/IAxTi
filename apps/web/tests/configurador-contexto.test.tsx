// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Configurador } from '../components/configurador';

const mocks = vi.hoisted(() => ({
  tenant: 'a', session: { access_token: 'token', user: { id: 'user' } }, config: { apiUrl: 'https://api.test' },
  apiFetch: vi.fn(), onboardingBusiness: vi.fn(), onboardingCosts: vi.fn(),
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => mocks.tenant }));
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), apiFetch: mocks.apiFetch }));
vi.mock('@iaxti/sdk', async (original) => ({ ...await original<typeof import('@iaxti/sdk')>(), onboardingBusiness: mocks.onboardingBusiness, onboardingCosts: mocks.onboardingCosts }));
vi.mock('@iaxti/ui/react', async (original) => ({ ...await original<typeof import('@iaxti/ui/react')>(), useSession: () => ({ session: mocks.session, config: mocks.config }) }));
const proposal = (name: string) => ({ id: name, status: 'pending', vertical: 'otro', aplicadaPor: null, diff: { antes: { pipelines: [], quickReplies: [] }, items: [{ tipo: 'pipeline', nombre: name, detalle: 'nuevo', accion: 'crear' }], nota: null } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.tenant = 'a';
  mocks.onboardingBusiness.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({ description: `Descripción de ${tenantId}`, vertical: 'otro' }));
  mocks.onboardingCosts.mockResolvedValue({ cicloEnCurso: { metaUsd: 1.25, usdClpRate: 900, ia: { usd: 0.5, clp: 450 } } });
});
afterEach(cleanup);

it('GET propuesta A tardío no aparece después de cambiar a B', async () => {
  let finish!: (data: unknown) => void;
  mocks.apiFetch.mockImplementation((_config, _session, tenant, path) => path.endsWith('/quien') ? Promise.resolve({ agente: null, propio: false })
    : tenant === 'a' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(proposal('Negocio B')));
  const view = render(<Configurador />);
  await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
  mocks.tenant = 'b'; view.rerender(<Configurador />);
  expect(await screen.findByText('Pipeline: Negocio B')).toBeInTheDocument();
  await act(async () => finish(proposal('Negocio A')));
  expect(screen.queryByText('Pipeline: Negocio A')).not.toBeInTheDocument();
  expect(screen.getByText('Pipeline: Negocio B')).toBeInTheDocument();
  expect(mocks.apiFetch.mock.calls[0]![4].signal.aborted).toBe(true);
});

it('acción A tardía no borra propuesta B ni muestra éxito A; doble clic manda solo un POST', async () => {
  let finish!: (data: unknown) => void;
  mocks.apiFetch.mockImplementation((_config, _session, tenant, path, options) => options?.method === 'POST'
    ? new Promise((resolve) => { finish = resolve; })
    : Promise.resolve(path.endsWith('/quien') ? { agente: null, propio: false } : proposal(`Negocio ${tenant}`)));
  const view = render(<Configurador />);
  const apply = await screen.findByRole('button', { name: 'Aplicar lo nuevo' });
  await userEvent.dblClick(apply);
  expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  expect(mocks.apiFetch.mock.calls.filter((call) => call[4]?.method === 'POST')).toHaveLength(1);
  mocks.tenant = 'b'; view.rerender(<Configurador />);
  expect(await screen.findByText('Pipeline: Negocio b')).toBeInTheDocument();
  await act(async () => finish({ creado: { pipeline: true, quickReplies: 5 } }));
  expect(screen.getByText('Pipeline: Negocio b')).toBeInTheDocument();
  expect(screen.queryByText(/5 respuestas rápidas/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Aplicar lo nuevo' })).toBeEnabled();
  expect(mocks.onboardingCosts).not.toHaveBeenCalled();
});

it('al aplicar la configuración muestra Meta e IA sin hacer un cobro', async () => {
  mocks.apiFetch.mockImplementation((_config, _session, _tenant, path, options) => Promise.resolve(options?.method === 'POST'
    ? { creado: { pipeline: true, quickReplies: 2 } }
    : path.endsWith('/quien') ? { agente: null, propio: false } : proposal('Negocio')));
  render(<Configurador />);
  await userEvent.click(await screen.findByRole('button', { name: 'Aplicar lo nuevo' }));
  expect(await screen.findByText(/USD 1.2500/)).toBeInTheDocument();
  expect(screen.getByText(/USD 0.5000/)).toBeInTheDocument();
  expect(screen.getByText(/no un cobro/)).toBeInTheDocument();
  expect(mocks.onboardingCosts).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'a' }), expect.any(AbortSignal));
});

it('al retomar una propuesta aplicada conserva los costos visibles', async () => {
  mocks.apiFetch.mockImplementation((_config, _session, _tenant, path) => Promise.resolve(path.endsWith('/quien')
    ? { agente: null, propio: false } : { ...proposal('Negocio'), status: 'applied' }));
  render(<Configurador />);
  expect(await screen.findByText(/USD 1.2500/)).toBeInTheDocument();
  expect(screen.getByText(/USD 0.5000/)).toBeInTheDocument();
});

it('descripción tardía no pisa lo que la persona ya escribió', async () => {
  let finish!: (data: unknown) => void;
  mocks.onboardingBusiness.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mocks.apiFetch.mockImplementation((_config, _session, _tenant, path) => Promise.resolve(path.endsWith('/quien') ? { agente: null, propio: false } : null));
  render(<Configurador />);
  const description = screen.getByRole('textbox', { name: 'Descripción del negocio' });
  await userEvent.type(description, 'Lo escribí después');
  await act(async () => finish({ description: 'Descripción vieja', vertical: 'belleza' }));
  expect(description).toHaveValue('Lo escribí después');
});
