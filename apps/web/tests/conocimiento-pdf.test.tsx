// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@iaxti/ui/react';
import { SubirPdf } from '../components/conocimiento-pdf';

const { pedir } = vi.hoisted(() => ({ pedir: vi.fn() }));
// El módulo entero y no solo `apiFetch` (#1161): el componente también usa
// `mensajeDeError`, y un mock que solo declara una de las dos deja la otra en
// `undefined` — el `catch` explota y el aviso nunca aparece, que es cómo se
// cayó esta prueba.
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiFetch: pedir,
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...(await original<typeof import('@iaxti/ui/react')>()),
  useSession: () => ({ config: { apiUrl: 'http://localhost' }, session: { access_token: 'fixture' } }),
}));

class SubidaDePrueba {
  static ultima: SubidaDePrueba;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 200;
  onload?: () => void;
  onerror?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  constructor() { SubidaDePrueba.ultima = this; }
}

beforeEach(() => {
  pedir.mockReset();
  localStorage.setItem('iaxti-tenant', 'negocio-de-prueba');
  vi.stubGlobal('XMLHttpRequest', SubidaDePrueba);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('el PDF sigue usando su selector nativo con Label (#519)', () => {
  it('informa un archivo inválido y permite volver a elegir, sin solicitar una subida', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('error-de-prueba');
    const terminar = vi.fn();
    render(<SubirPdf alTerminar={terminar} />);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByLabelText('elige un archivo'), new File(['texto'], 'nota.txt', { type: 'text/plain' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Por acá entran PDF'), expect.anything()));
    expect(screen.getByLabelText('elige un archivo')).toBeEnabled();
    expect(pedir).not.toHaveBeenCalled();
    expect(terminar).not.toHaveBeenCalled();
  });

  it('conserva subida, progreso real, indexación y vuelta al selector al terminar', async () => {
    let terminarIndice!: () => void;
    pedir.mockResolvedValueOnce({ key: 'negocio/menu.pdf', uploadUrl: 'http://localhost/subida-fixture' });
    pedir.mockImplementationOnce(() => new Promise<void>((resolve) => { terminarIndice = resolve; }));
    const terminar = vi.fn();
    render(<SubirPdf alTerminar={terminar} />);
    const archivo = new File(['%PDF'], 'menu.pdf', { type: 'application/pdf' });
    await userEvent.setup().upload(screen.getByLabelText('elige un archivo'), archivo);
    expect(SubidaDePrueba.ultima.send).toHaveBeenCalledWith(archivo);
    expect(screen.getByRole('progressbar', { name: 'Subida del PDF' })).toHaveAttribute('value', '0');
    act(() => SubidaDePrueba.ultima.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50');
    await act(async () => SubidaDePrueba.ultima.onload?.());
    expect(screen.getByText(/Subido. Leyendo el documento/)).toBeInTheDocument();
    expect(terminar).not.toHaveBeenCalled();
    await act(async () => terminarIndice());
    expect(terminar).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('elige un archivo') as HTMLInputElement).value).toBe('');
  });

  it('si la API rechaza la subida, muestra el motivo y conserva la posibilidad de reintentar', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('error-de-prueba');
    pedir.mockRejectedValueOnce(new Error('No tienes permiso para cargar una fuente.'));
    const terminar = vi.fn();
    render(<SubirPdf alTerminar={terminar} />);
    await userEvent.setup().upload(screen.getByLabelText('elige un archivo'), new File(['%PDF'], 'menu.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('No tienes permiso para cargar una fuente.', expect.anything()));
    expect(screen.getByLabelText('elige un archivo')).toBeEnabled();
    expect(terminar).not.toHaveBeenCalled();
  });
});
