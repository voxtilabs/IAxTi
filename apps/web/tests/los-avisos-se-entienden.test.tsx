// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Los avisos se entienden (#1410): cada aviso con sus canales NOMBRADOS al
 * lado — «Campana» no decía nada, y a 390 px la tabla cortaba la columna de
 * WhatsApp: escondida y sin forma de usarla.
 */
const contexto = vi.hoisted(() => ({ tenant: 'negocio-a' }));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => ({
    config: { apiUrl: 'http://api.local' },
    session: { access_token: 'sesion-a' },
  }),
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { PreferenciasAvisos } from '../components/preferencias-avisos';

const pedir = vi.mocked(apiFetch);
const PREFS = [
  { type: 'conversacion_sin_dueno', campana: true, correo: true, push: true, whatsapp: false, bloqueada: false, whatsappNoAplica: true },
  { type: 'calidad_numero', campana: true, correo: true, push: true, whatsapp: false, bloqueada: true, whatsappNoAplica: false },
];

beforeEach(() => pedir.mockReset());

describe('la pantalla de avisos', () => {
  it('cada canal lleva su nombre al lado, sin «Campana»', async () => {
    pedir.mockResolvedValue(PREFS as never);
    render(<PreferenciasAvisos />);
    await screen.findByText('Conversación nueva sin dueño');
    // «Campana» se fue de la pantalla: si vuelve, aquí se ve.
    expect(screen.queryByText('Campana')).toBeNull();
    const fila = screen.getByText('Conversación nueva sin dueño').closest('li')!;
    expect(within(fila).getByText('Aviso')).toBeTruthy();
    expect(within(fila).getByText('Correo')).toBeTruthy();
    expect(within(fila).getByText('Celular')).toBeTruthy();
    expect(within(fila).getByText('WhatsApp')).toBeTruthy();
  });

  it('la explicación nombra los cuatro canales y qué hace cada uno', async () => {
    pedir.mockResolvedValue(PREFS as never);
    render(<PreferenciasAvisos />);
    const texto = (await screen.findByText(/Elige dónde te enteras/)).textContent ?? '';
    expect(texto).toContain('Celular');
    expect(texto).toContain('WhatsApp');
  });

  it('apagar una casilla guarda ese tipo con ese canal', async () => {
    pedir.mockResolvedValue(PREFS as never);
    render(<PreferenciasAvisos />);
    const fila = (await screen.findByText('Conversación nueva sin dueño')).closest('li')!;
    fireEvent.click(within(fila).getAllByRole('checkbox')[0]);
    await waitFor(() => expect(pedir).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'negocio-a', '/notifications/preferences', expect.objectContaining({ method: 'PUT' })));
    const put = pedir.mock.calls.find((c) => c[4] && (c[4] as { method?: string }).method === 'PUT')!;
    const cuerpo = JSON.parse(String(put[4]!.body));
    expect(cuerpo.type).toBe('conversacion_sin_dueno');
    expect(cuerpo.campana).toBe(false);
  });
});
