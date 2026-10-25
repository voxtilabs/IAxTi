// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebchatChat } from '../components/webchat-chat';

/**
 * La identidad sola se puede ENVIAR (#1059), probado usándolo (#564):
 * el visitante pregunta, el widget le pide sus datos, los rellena y aprieta
 * enviar SIN escribir otro mensaje. Antes el botón quedaba `disabled` por el
 * campo de texto vacío y `enviar()` retornaba en silencio — medido en vivo
 * por el dueño, rellenando sus datos sin forma de subirlos.
 */

// jsdom no implementa scrollIntoView y el chat lo usa al agregar burbujas.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const llamadas: Array<{ url: string; body: Record<string, unknown> }> = [];

function fetchFalso() {
  return vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'POST') llamadas.push({ url, body });
    if (url.includes('/sessions')) {
      return new Response(JSON.stringify({ sessionId: 's-1', welcomeMessage: '¡Hola!' }), { status: 200 });
    }
    if (url.includes('/messages') && init?.method === 'POST') {
      // Primer mensaje: anónimo → pide identidad. Segundo: identidad sola → entregado.
      const conIdentidad = Boolean((body.visitor as { phone?: string } | undefined)?.phone);
      return new Response(JSON.stringify({ status: conIdentidad ? 'delivered' : 'need_identity' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  llamadas.length = 0;
  vi.unstubAllGlobals();
});

describe('la identidad sola se puede enviar (#1059)', () => {
  it('rellenar teléfono habilita el botón sin texto nuevo, y el POST va sin body', async () => {
    vi.stubGlobal('fetch', fetchFalso());
    const usuario = userEvent.setup();
    render(<WebchatChat apiUrl="http://api.local" widgetId="w-1" page="http://sitio.cl" />);

    // El visitante pregunta algo (anónimo) y el widget pide identidad.
    const campo = await screen.findByLabelText('Tu mensaje');
    await usuario.type(campo, '¿Atienden los sábados?');
    await usuario.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByLabelText('Tu teléfono o correo');

    // Sin texto nuevo y sin identidad, el botón sigue muerto (como siempre).
    const boton = screen.getByRole('button', { name: 'Enviar' });
    expect(boton).toBeDisabled();

    // Rellena sus datos — y el botón VIVE, aunque el mensaje esté vacío.
    await usuario.type(screen.getByLabelText('Tu nombre'), 'Lino Prueba');
    await usuario.type(screen.getByLabelText('Tu teléfono o correo'), '+56999000456');
    expect(boton).toBeEnabled();

    await usuario.click(boton);
    await waitFor(() => expect(llamadas.filter((l) => l.url.includes('/messages'))).toHaveLength(2));
    const segundo = llamadas.filter((l) => l.url.includes('/messages'))[1];
    // La identidad viaja sola: sin body, con el teléfono adentro.
    expect(segundo.body.body).toBeUndefined();
    expect((segundo.body.visitor as { phone?: string }).phone).toBe('+56999000456');
  });
});
