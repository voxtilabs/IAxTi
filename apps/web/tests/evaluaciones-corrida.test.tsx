// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorridaDto } from '../components/evaluaciones';

const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a', config: { apiUrl: 'http://api.local' }, session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(), useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...await original<typeof import('../lib/api')>(), apiFetch: vi.fn(),
}));
// Solo se simplifica el control visual Radix. La selección, useCarga y el
// componente son reales: los cambios de contexto deben cancelar su estado.
vi.mock('../components/selector-de-asistente', async (original) => ({
  ...await original<typeof import('../components/selector-de-asistente')>(),
  SelectorDeAsistente: ({ asistentes, elegidoId, onElegir }: {
    asistentes: Array<{ id: string; name: string }>; elegidoId: string | null; onElegir: (id: string) => void;
  }) => <select aria-label="De qué asistente" value={elegidoId ?? ''} onChange={(e) => onElegir(e.target.value)}>
    {asistentes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
  </select>,
}));
import { ApiError, apiFetch } from '../lib/api';
import { Evaluaciones } from '../components/evaluaciones';

const pedir = vi.mocked(apiFetch);
const corrida = (id: string, score: number): CorridaDto => ({
  id, score, provider: 'openai', model: 'modelo-de-prueba', promptVersion: null,
  caseCount: 10, casesMedidos: 10, createdAt: '2026-10-16T12:00:00Z',
});
const agentes = ['a', 'b'].map((id) => ({ id, name: `Asistente ${id}`, provider: 'openai', model: 'modelo-de-prueba' }));
function diferida<T>() {
  let resolver!: (dato: T) => void;
  let rechazar!: (error: Error) => void;
  const promesa = new Promise<T>((resolve, reject) => { resolver = resolve; rechazar = reject; });
  return { promesa, resolver, rechazar };
}
const resolver = async <T,>(d: ReturnType<typeof diferida<T>>, dato: T) => {
  await act(async () => { d.resolver(dato); await d.promesa; });
};
beforeEach(() => {
  contexto.tenant = 'negocio-a'; contexto.session = { access_token: 'sesion-a' }; pedir.mockReset();
});

describe('la medición pagada de Evaluaciones (#588)', () => {
  it('muestra la respuesta guardada y conserva la anterior aunque el próximo GET fallaría', async () => {
    let lecturas = 0;
    pedir.mockImplementation(async (_c, _s, _t, ruta) => {
      if (ruta === '/agents') return agentes;
      if (ruta.endsWith('/evaluate')) return corrida('nueva', 0.93);
      if (++lecturas > 1) throw new ApiError('EVALS_FAILED', 'No se pudo recargar.', 500, 'req_recarga');
      return [corrida('anterior', 0.72)];
    });
    render(<Evaluaciones />);
    await screen.findByText('72%');
    fireEvent.click(screen.getByRole('button', { name: 'Medir ahora' }));
    expect(await screen.findByText('93%')).toBeVisible();
    expect(screen.getByText('72%')).toBeVisible();
    expect(screen.getByText('+21 puntos vs. la anterior')).toBeVisible();
    expect(lecturas).toBe(1);
    expect(pedir.mock.calls.filter((c) => c[3].endsWith('/evaluate'))).toHaveLength(1);
  });

  it('el vacío no cobra dos veces mientras la primera medición está en vuelo', async () => {
    const pagada = diferida<CorridaDto>();
    pedir.mockImplementation(async (_c, _s, _t, ruta) => ruta === '/agents' ? agentes : ruta.endsWith('/evaluate') ? pagada.promesa : []);
    render(<Evaluaciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Medir ahora' }));
    fireEvent.click(screen.getByRole('button', { name: 'Midiendo…' }));
    expect(pedir.mock.calls.filter((c) => c[3].endsWith('/evaluate'))).toHaveLength(1);
    await resolver(pagada, corrida('primera', 0.93));
    expect(screen.getByText('93%')).toBeVisible();
    expect(screen.queryByText('Todavía no se ha medido nada')).not.toBeInTheDocument();
  });

  it('un fallo de la medición conserva historial y code/requestId, y permite volver a medir', async () => {
    pedir.mockImplementation(async (_c, _s, _t, ruta) => {
      if (ruta === '/agents') return agentes;
      if (ruta.endsWith('/evaluate')) throw new ApiError('EVAL_FAILED', 'No se pudo medir.', 500, 'req_medicion');
      return [corrida('anterior', 0.72)];
    });
    render(<Evaluaciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Medir ahora' }));
    expect(await screen.findByText('EVAL_FAILED · req_medicion')).toBeVisible();
    expect(screen.getByText('72%')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Medir ahora' })).toBeEnabled();
  });

  it.each(['tenant', 'sesion', 'asistente'] as const)('no mezcla la corrida tardía tras cambiar %s', async (cambio) => {
    const pagada = diferida<CorridaDto>();
    pedir.mockImplementation(async (_c, sesion, tenant, ruta) => {
      if (ruta === '/agents') return agentes;
      if (ruta.endsWith('/evaluate')) return pagada.promesa;
      return [corrida('historial', tenant === 'negocio-b' || sesion.access_token === 'sesion-b' || ruta.includes('/b/') ? 0.51 : 0.72)];
    });
    const vista = render(<Evaluaciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Medir ahora' }));
    if (cambio === 'asistente') fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    else {
      if (cambio === 'tenant') contexto.tenant = 'negocio-b';
      else contexto.session = { access_token: 'sesion-b' };
      vista.rerender(<Evaluaciones />);
    }
    expect(screen.queryByText('72%')).not.toBeInTheDocument();
    await screen.findByText('51%');
    await resolver(pagada, corrida('vieja-pagada', 0.93));
    expect(screen.getByText('51%')).toBeVisible();
    expect(screen.queryByText('93%')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Medir ahora' })).toBeEnabled();
  });

  it('tampoco expone el error tardío de la sesión anterior', async () => {
    const pagada = diferida<CorridaDto>();
    pedir.mockImplementation(async (_c, _s, _t, ruta) => ruta === '/agents' ? agentes : ruta.endsWith('/evaluate') ? pagada.promesa : [corrida('historial', 0.72)]);
    const vista = render(<Evaluaciones />);
    fireEvent.click(await screen.findByRole('button', { name: 'Medir ahora' }));
    contexto.session = { access_token: 'sesion-b' };
    vista.rerender(<Evaluaciones />);
    await screen.findByText('72%');
    await act(async () => { pagada.rechazar(new ApiError('VIEJA', 'Error de otra sesión.', 500, 'req_vieja')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Medir ahora' })).toBeEnabled());
    expect(screen.queryByText(/req_vieja/)).not.toBeInTheDocument();
  });
});
