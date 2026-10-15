// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useArrastre } from '../src/react/use-arrastre';

/**
 * Las tres cosas de `useArrastre` que hasta ahora solo estaban DESCRITAS (#564).
 *
 * El hook tiene tres comportamientos que su propio docblock explica con cuidado
 * —el hijo que no apaga el resaltado, pegar una imagen, y pegar texto sin
 * comérselo— y ninguna prueba los ejercitaba: las de `apps/web` leen el código
 * fuente y buscan patrones, así que lo máximo que podían afirmar era que el
 * código DIGA que cuenta las entradas, no que contando funcione.
 *
 * Y las guardas de fuente son frágiles al refactor por el otro lado: cambiar
 * `if (await onResponder(` por una variable intermedia las pone rojas sin que
 * nada se haya roto. Eso enseña a apagarlas, que es lo peor que le puede pasar
 * a una prueba. Esta no mira cómo está escrito el hook; mira qué hace.
 *
 * `jsdom` y no `happy-dom`, y la medición está en `.claude/rules/testing.md`:
 * happy-dom arranca más rápido, pero su `DataTransfer` no lleva `files`, que
 * es justamente el dato del que dependen los tres casos.
 */

/** Un `DataTransfer` con archivos, que es lo que el navegador manda al soltar. */
function conArchivos(archivos: File[]): DataTransfer {
  return {
    files: archivos,
    items: archivos.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    types: archivos.length > 0 ? ['Files'] : ['text/plain'],
  } as unknown as DataTransfer;
}

function Zona({ alRecibir, activo = true }: { alRecibir: (f: File) => void; activo?: boolean }) {
  const arrastre = useArrastre({ alRecibir, activo });
  return (
    <div data-testid="zona" {...arrastre.props}>
      <span data-testid="hijo">Suelta el archivo acá</span>
      <p data-testid="estado">{arrastre.arrastrando ? 'resaltado' : 'quieto'}</p>
      <textarea data-testid="campo" onPaste={arrastre.alPegar} />
    </div>
  );
}

const unaFoto = () => new File(['x'], 'captura.png', { type: 'image/png' });

describe('arrastrar y pegar, de verdad (#564)', () => {
  it('pasar por encima de un hijo NO apaga el resaltado', () => {
    render(<Zona alRecibir={vi.fn()} />);
    const zona = screen.getByTestId('zona');
    const hijo = screen.getByTestId('hijo');
    const datos = conArchivos([unaFoto()]);

    fireEvent.dragEnter(zona, { dataTransfer: datos });
    expect(screen.getByTestId('estado')).toHaveTextContent('resaltado');

    // El navegador manda el `dragenter` del hijo ANTES del `dragleave` del
    // padre. Con un booleano en vez de un contador, acá se apagaba y el
    // resaltado parpadeaba al mover el mouse por adentro.
    fireEvent.dragEnter(hijo, { dataTransfer: datos });
    fireEvent.dragLeave(zona, { dataTransfer: datos });
    expect(screen.getByTestId('estado')).toHaveTextContent('resaltado');

    // Y al salir de verdad, sí se apaga.
    fireEvent.dragLeave(hijo, { dataTransfer: datos });
    expect(screen.getByTestId('estado')).toHaveTextContent('quieto');
  });

  it('soltar entrega el archivo y apaga el resaltado', () => {
    const alRecibir = vi.fn();
    render(<Zona alRecibir={alRecibir} />);
    const zona = screen.getByTestId('zona');
    const foto = unaFoto();

    fireEvent.dragEnter(zona, { dataTransfer: conArchivos([foto]) });
    fireEvent.drop(zona, { dataTransfer: conArchivos([foto]) });

    expect(alRecibir).toHaveBeenCalledWith(foto);
    expect(screen.getByTestId('estado')).toHaveTextContent('quieto');
  });

  it('pegar una imagen la adjunta', () => {
    const alRecibir = vi.fn();
    render(<Zona alRecibir={alRecibir} />);
    const foto = unaFoto();

    fireEvent.paste(screen.getByTestId('campo'), { clipboardData: conArchivos([foto]) });

    expect(alRecibir).toHaveBeenCalledWith(foto);
  });

  it('pegar TEXTO no se intercepta: sigue siendo pegar texto', () => {
    const alRecibir = vi.fn();
    render(<Zona alRecibir={alRecibir} />);

    const evento = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evento, 'clipboardData', { value: conArchivos([]) });
    fireEvent(screen.getByTestId('campo'), evento);

    expect(alRecibir).not.toHaveBeenCalled();
    // Lo que de verdad importa: que NO se haya cancelado, porque cancelar es
    // lo que le rompe el Ctrl+V a quien está escribiendo un mensaje.
    expect(evento.defaultPrevented).toBe(false);
  });

  it('apagado no acepta nada ni se resalta', () => {
    const alRecibir = vi.fn();
    render(<Zona alRecibir={alRecibir} activo={false} />);
    const zona = screen.getByTestId('zona');
    const datos = conArchivos([unaFoto()]);

    fireEvent.dragEnter(zona, { dataTransfer: datos });
    expect(screen.getByTestId('estado')).toHaveTextContent('quieto');
    fireEvent.drop(zona, { dataTransfer: datos });
    expect(alRecibir).not.toHaveBeenCalled();
  });
});
