// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * El paso de la cuenta no pide que se le crea (#1400).
 *
 * «Quedó anotado; no lo comprobamos ahora.» es la marca de los pasos que
 * solo constan en la columna — y en el PASO DE LA CUENTA sonaba a que el
 * registro estaba en duda: la dueña acaba de registrarse, es lo primero que
 * lee, y no tiene verificador por diseño, porque nadie va a re-comprobar que
 * se registró. En los demás pasos la marca se queda: ahí sí es información
 * (esto figura hecho y nadie lo miró hoy).
 */

const mocks = vi.hoisted(() => ({
  getOnboarding: vi.fn(),
  onboardingBusiness: vi.fn(),
  onboardingCosts: vi.fn(),
}));
vi.mock('@iaxti/sdk', async (original) => ({
  ...await original<typeof import('@iaxti/sdk')>(),
  getOnboarding: mocks.getOnboarding,
  onboardingBusiness: mocks.onboardingBusiness,
  onboardingCosts: mocks.onboardingCosts,
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(),
  useSession: () => ({ session: { access_token: 's' }, config: { apiUrl: 'http://api.local' } }),
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => 'negocio-a' }));
import { PuestaEnMarcha } from '../components/puesta-en-marcha';

const paso = (id: string, titulo: string, hecho: boolean, fuente: 'verificado' | 'historial') => ({
  id, titulo, ayuda: 'Ayuda del paso.', opcional: false, hecho, bloqueado: false,
  detalle: null, fuente, ruta: null,
});

/** Los pasos que constan en la columna y nadie miró hoy. */
const progreso = (pasos: Array<ReturnType<typeof paso>>) => ({
  estadoRegistrado: 'first_message', completo: false, siguiente: 'first_message', desfase: [], pasos,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onboardingBusiness.mockResolvedValue({ plan: 'base', state: 'trial', trialEndsAt: null });
  mocks.onboardingCosts.mockResolvedValue({ cicloEnCurso: null });
});

describe('la marca de «quedó anotado»', () => {
  it('el paso de la cuenta NO la lleva, aunque no tenga verificador', async () => {
    mocks.getOnboarding.mockResolvedValue(
      progreso([
        paso('registered', 'Crea tu cuenta', true, 'historial'),
        // Otro paso que también conste solo en la columna: la marca es
        // información acá, y tiene que seguir saliendo.
        paso('knowledge_added', 'Sube lo que vendes', true, 'historial'),
      ]),
    );
    render(<PuestaEnMarcha />);
    expect(await screen.findByText('Crea tu cuenta')).toBeInTheDocument();
    expect(screen.getByText('Sube lo que vendes')).toBeInTheDocument();
    // Una sola marca, y es la del catálogo — no la de la cuenta.
    expect(screen.getAllByText('Quedó anotado; no lo comprobamos ahora.')).toHaveLength(1);
    const cuenta = screen.getByText('Crea tu cuenta').closest('li')!;
    expect(cuenta.textContent).not.toContain('Quedó anotado');
  });

  it('con todo verificado, no hay marca en ningún paso', async () => {
    mocks.getOnboarding.mockResolvedValue(
      progreso([
        paso('registered', 'Crea tu cuenta', true, 'historial'),
        paso('knowledge_added', 'Sube lo que vendes', true, 'verificado'),
      ]),
    );
    render(<PuestaEnMarcha />);
    await screen.findByText('Crea tu cuenta');
    expect(screen.queryByText('Quedó anotado; no lo comprobamos ahora.')).not.toBeInTheDocument();
  });
});
