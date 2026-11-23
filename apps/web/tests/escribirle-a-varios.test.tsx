// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Escribirle a varios» no ofrece el botón de enviar hasta que la previa está
 * en pantalla (#1247).
 *
 * Un WhatsApp no se puede deshacer: el paso obligatorio del producto es VER a
 * quién le llega —el conteo, la muestra, los que quedan fuera— antes de que
 * exista un botón que mande algo. Si el botón apareciera junto al campo de
 * texto, el conteo sería un adorno.
 */
const contexto = vi.hoisted(() => ({
  tenant: 'negocio-a', config: { apiUrl: 'http://api.local' },
  session: { access_token: 'sesion-a' },
}));
vi.mock('@iaxti/ui/react', async (original) => ({
  ...await original<typeof import('@iaxti/ui/react')>(),
  useSession: () => contexto,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => contexto.tenant }));
vi.mock('../lib/api', async (original) => ({
  ...await original<typeof import('../lib/api')>(), apiFetch: vi.fn(),
}));
import { apiFetch } from '../lib/api';
import { EscribirleAVarios } from '../components/bandeja/escribirle-a-varios';

const pedir = vi.mocked(apiFetch);

/* Radix usa APIs de puntero que jsdom no trae (el Select y el Dialog caen
   con `hasPointerCapture is not a function`). */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};
Element.prototype.scrollIntoView = () => {};

const PREVIA = {
  id: 'd1',
  texto: 'Gracias por venir al stand',
  total: 3,
  muestra: [
    { conversationId: 'c1', nombre: 'Ana', telefono: '+56933···01' },
    { conversationId: 'c2', nombre: 'Pedro', telefono: '+56933···02' },
  ],
  fuera: [
    { motivo: 'ventana cerrada', n: 2 },
    { motivo: 'se dio de baja', n: 1 },
  ],
  truncado: false,
  enSilencio: false,
};

beforeEach(() => {
  pedir.mockReset();
});

describe('el botón de enviar', () => {
  it('no existe antes de ver la previa, y aparece con el conteo después', async () => {
    pedir.mockResolvedValueOnce(PREVIA as never);
    render(<EscribirleAVarios abierto onCerrar={vi.fn()} etiquetas={[]} />);

    // Se escribe el texto primero: sin texto tampoco hay previa que ver. El
    // texto entra de una vez y no tecla por tecla — con la máquina cargada,
    // tipear 27 caracteres en jsdom se comía el plazo del test entero sin
    // decir nada del componente.
    fireEvent.change(screen.getByLabelText('El mensaje'), {
      target: { value: 'Gracias por venir al stand' },
    });
    expect(screen.queryByRole('button', { name: /^Enviar a / })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Ver a quién le llega' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enviar a 3' })).toBeTruthy();
    });
    // La previa dice el conteo y quiénes quedan fuera, con su motivo.
    expect(screen.getByText(/personas van a recibir este texto/)).toBeTruthy();
    expect(screen.getByText(/con la ventana de 24 h cerrada/)).toBeTruthy();
    expect(screen.getByText(/que pidió no recibir mensajes/)).toBeTruthy();
    expect(pedir).toHaveBeenCalledWith(
      contexto.config, contexto.session, contexto.tenant,
      '/conversations/difusion/previa',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('con la previa en silencio, lo dice: se difiere, no se esconde', async () => {
    pedir.mockResolvedValueOnce({ ...PREVIA, enSilencio: true } as never);
    render(<EscribirleAVarios abierto onCerrar={vi.fn()} etiquetas={[]} />);
    await userEvent.type(screen.getByLabelText('El mensaje'), 'Gracias');
    await userEvent.click(screen.getByRole('button', { name: 'Ver a quién le llega' }));
    await waitFor(() => {
      expect(screen.getByText(/horario de silencio/)).toBeTruthy();
    });
  });
});
