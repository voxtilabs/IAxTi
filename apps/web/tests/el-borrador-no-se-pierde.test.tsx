// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chat } from '../components/bandeja/chat';

/**
 * Un envío que falla conserva lo escrito (#560, probado de verdad por #564).
 *
 * Esto ya tenía una guarda de fuente, y lo que podía afirmar era que
 * `onResponder` devolviera un booleano y que alguien lo mirara. Lo que no
 * podía afirmar es lo único que le importa a quien atiende: que el texto SIGA
 * AHÍ después de que el envío falle.
 *
 * Y la guarda de fuente es frágil justo donde más duele: cambiar
 * `if (!(await onResponder(` por una variable intermedia la pone roja sin que
 * nada se haya roto, lo que enseña a apagarla. Ésta no mira cómo está escrito
 * el componente; escribe en el campo, aprieta Enviar y mira qué quedó.
 *
 * Por qué importa tanto: perder lo redactado porque WhatsApp cerró la ventana
 * obliga a escribirlo de nuevo, y eso pasa a diario.
 */

/** Lo mínimo para que el chat se dibuje: lo demás no participa de este caso. */
const props = (onResponder: (t: string, a?: File) => Promise<boolean>) =>
  ({
    detalle: {
      id: 'c1',
      contact: { id: 'k1', name: 'Rosa', phone: '+56955550101' },
      state: 'open',
      channel: 'whatsapp',
      ventana24h: { abierta: true, cierraEn: null },
    },
    mensajes: [],
    atajos: [],
    sugerencia: null,
    sinSugerencia: null,
    modo: 'assist',
    miId: 'u1',
    aviso: null,
    limitesDeAdjunto: null,
    onVolver: vi.fn(),
    onVerFicha: vi.fn(),
    onResponder,
    onAsignar: vi.fn(async () => true),
    onEstado: vi.fn(async () => true),
    onPrioridad: vi.fn(async () => true),
    onSugerencia: vi.fn(),
    onModo: vi.fn(),
    onCobrar: vi.fn(async () => true),
    onCrearOportunidad: vi.fn(async () => true),
    plantillas: [],
    onCargarPlantillas: vi.fn(),
    onEnviarPlantilla: vi.fn(async () => true),
    onAbrirAdjunto: vi.fn(),
  }) as unknown as Parameters<typeof Chat>[0];

describe('el borrador no se pierde (#560)', () => {
  it('si el envío NO sale, lo escrito vuelve al campo', async () => {
    const usuario = userEvent.setup();
    // Lo que pasa a diario: la ventana de 24 h se cerró y el servidor rechaza.
    const onResponder = vi.fn(async () => false);
    render(<Chat {...props(onResponder)} />);

    const campo = screen.getByPlaceholderText('Escribe tu respuesta…');
    await usuario.type(campo, 'Hola Rosa, te confirmo la hora');
    await usuario.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(onResponder).toHaveBeenCalledWith('Hola Rosa, te confirmo la hora', undefined);
    // Lo único que importa acá.
    expect(campo).toHaveValue('Hola Rosa, te confirmo la hora');
  });

  it('si SÍ sale, el campo queda vacío', async () => {
    const usuario = userEvent.setup();
    render(<Chat {...props(vi.fn(async () => true))} />);

    const campo = screen.getByPlaceholderText('Escribe tu respuesta…');
    await usuario.type(campo, 'Listo, te espero');
    await usuario.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(campo).toHaveValue('');
  });

  it('lo escrito DESPUÉS del fallo manda: no se pisa con lo viejo', async () => {
    const usuario = userEvent.setup();
    // El envío tarda, y mientras tanto la persona escribe otra cosa. Reponer
    // el borrador viejo encima sería borrarle lo nuevo.
    let resolver: (salio: boolean) => void = () => {};
    const onResponder = vi.fn(() => new Promise<boolean>((r) => { resolver = r; }));
    render(<Chat {...props(onResponder)} />);

    const campo = screen.getByPlaceholderText('Escribe tu respuesta…');
    const enviar = screen.getByRole('button', { name: 'Enviar' });
    await usuario.type(campo, 'lo primero');
    await usuario.click(enviar);
    await usuario.type(campo, 'lo segundo');
    resolver(false);

    /**
     * Se espera a que el envío TERMINE antes de mirar, y eso no es paciencia:
     * la primera versión de esta prueba miraba el campo apenas resuelta la
     * promesa y pasaba con cualquier implementación, porque React todavía no
     * había aplicado nada. Era una prueba que no podía fallar — justo lo que
     * este archivo viene a reemplazar.
     *
     * El botón volviendo a habilitarse es la señal observable de que el
     * `finally` corrió: a partir de ahí, lo que haya en el campo es lo que la
     * persona va a ver.
     */
    await waitFor(() => expect(enviar).toBeEnabled());
    expect(campo).toHaveValue('lo segundo');
  });
});
