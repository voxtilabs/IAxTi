// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegistroInicial } from '../components/registro-inicial';
import { OnboardingCostos } from '../components/onboarding-costos';

const mocks = vi.hoisted(() => ({
  myBusinesses: vi.fn(), registerBusiness: vi.fn(), onboardingBusiness: vi.fn(), onboardingCosts: vi.fn(),
  session: { access_token: 'test-token', user: { id: 'user-a' } }, config: { apiUrl: 'https://api.test' },
}));
vi.mock('@iaxti/sdk', async (original) => ({ ...await original<typeof import('@iaxti/sdk')>(), ...mocks }));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(), useSession: () => ({ session: mocks.session, config: mocks.config }),
}));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); mocks.session = { access_token: 'test-token', user: { id: 'user-a' } };
  mocks.myBusinesses.mockResolvedValue({ tenants: [] });
});
afterEach(cleanup);
async function fill() {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: 'Pon tu negocio en marcha' });
  await user.type(screen.getByRole('textbox', { name: 'Tu nombre' }), 'Ana');
  await user.type(screen.getByRole('textbox', { name: 'Nombre del negocio' }), 'Barbería Ana');
  await user.type(screen.getByRole('textbox', { name: 'Descripción del negocio' }), 'Barbería con reservas de hora');
  return user;
}

it('no ofrece alta hasta confirmar /me vacío; error permite reintento sin fabricar vacío', async () => {
  mocks.myBusinesses.mockRejectedValueOnce(new Error('No pudimos verificar tus negocios.'));
  render(<RegistroInicial />);
  expect(screen.getByRole('status')).toHaveTextContent('Abriendo tus negocios');
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos verificar tus negocios');
  expect(screen.queryByRole('button', { name: 'Crear mi negocio' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Volver a intentar' }));
  expect(await screen.findByRole('button', { name: 'Crear mi negocio' })).toBeEnabled();
});

it('membresía existente selecciona negocio sin formulario ni POST', async () => {
  mocks.myBusinesses.mockResolvedValue({ tenants: [{ tenantId: 'existing', tenantName: 'Negocio', roleName: 'USER' }] });
  render(<RegistroInicial />);
  await waitFor(() => expect(localStorage.getItem('iaxti-tenant')).toBe('existing'));
  expect(screen.queryByRole('button', { name: 'Crear mi negocio' })).not.toBeInTheDocument();
  expect(mocks.registerBusiness).not.toHaveBeenCalled();
});

it('campos etiquetados, datos conservados tras error y una sola llave al reintentar', async () => {
  mocks.registerBusiness.mockRejectedValueOnce(new Error('No pudimos crear tu negocio.')).mockResolvedValueOnce({ tenantId: 'new' });
  render(<RegistroInicial />); const user = await fill();
  expect(screen.getByRole('combobox', { name: 'Rubro' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Crear mi negocio' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos crear tu negocio');
  expect(screen.getByRole('textbox', { name: 'Nombre del negocio' })).toHaveValue('Barbería Ana');
  await user.click(screen.getByRole('button', { name: 'Crear mi negocio' }));
  await waitFor(() => expect(localStorage.getItem('iaxti-tenant')).toBe('new'));
  const [a, b] = mocks.registerBusiness.mock.calls;
  expect(a![1]).toEqual({ displayName: 'Ana', name: 'Barbería Ana', description: 'Barbería con reservas de hora', vertical: 'otro' });
  expect(a![2]).toBe(b![2]);
});

it('carga bloquea doble envío y una respuesta de la sesión anterior no selecciona negocio', async () => {
  let finish!: (value: { tenantId: string }) => void;
  mocks.registerBusiness.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<RegistroInicial />); const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Crear mi negocio' }));
  expect(screen.getByRole('button', { name: 'Creando tu negocio…' })).toBeDisabled();
  mocks.session = { access_token: 'another-user', user: { id: 'user-b' } }; view.rerender(<RegistroInicial />);
  await screen.findByRole('heading', { name: 'Pon tu negocio en marcha' });
  await act(async () => finish({ tenantId: 'old-user-tenant' }));
  expect(localStorage.getItem('iaxti-tenant')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Crear mi negocio' })).toBeEnabled();
  expect(mocks.registerBusiness).toHaveBeenCalledTimes(1);
});

it('respuesta vieja de /me se ignora al desmontar', async () => {
  let finish!: (value: { tenants: Array<{ tenantId: string }> }) => void;
  mocks.myBusinesses.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<RegistroInicial />); view.unmount();
  await act(async () => finish({ tenants: [{ tenantId: 'old' }] }));
  expect(localStorage.getItem('iaxti-tenant')).toBeNull();
});

it('costos muestran trial y consumos separados sin presentarlos como cobro', async () => {
  mocks.onboardingBusiness.mockResolvedValue({ plan: 'crece', state: 'trial', trialEndsAt: '2026-11-01T12:00:00Z' });
  mocks.onboardingCosts.mockResolvedValue({ cicloEnCurso: { metaUsd: 1.25, usdClpRate: 900, ia: { usd: 0.5, clp: 450 } } });
  render(<OnboardingCostos tenant="one" />);
  expect(await screen.findByText(/Prueba gratis, sin tarjeta/)).toBeInTheDocument();
  expect(screen.getByText(/USD 1.2500/)).toHaveClass('dato');
  expect(screen.getByText(/USD 0.5000/)).toHaveClass('dato');
  expect(screen.getByText(/no un cobro/)).toBeInTheDocument();
});

it('costos: error ofrece reintento y ausencia no se representa como cero', async () => {
  mocks.onboardingBusiness.mockResolvedValue({ plan: 'crece', state: 'trial', trialEndsAt: null });
  mocks.onboardingCosts.mockRejectedValueOnce(new Error('No pudimos leer el consumo.')).mockResolvedValueOnce({ cicloEnCurso: null });
  render(<OnboardingCostos tenant="one" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos leer el consumo');
  await userEvent.click(screen.getByRole('button', { name: 'Actualizar costos' }));
  expect(await screen.findByText(/Todavía no hay un ciclo/)).toBeInTheDocument();
  expect(screen.queryByText(/USD 0.0000/)).not.toBeInTheDocument();
});
