// @vitest-environment jsdom
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Card } from '../src/react/ui/card';
import { Label } from '../src/react/ui/label';

describe('Card y Label conservan el contrato HTML (#519)', () => {
  it('Card es un div y entrega ref, atributos, contenido y eventos al mismo nodo', () => {
    const ref = createRef<HTMLDivElement>();
    const pulsar = vi.fn();
    render(
      <Card ref={ref} id="fuente" role="region" aria-label="Agregar fuente" onClick={pulsar}>
        <h2>Conocimiento del negocio</h2>
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Agregar fuente' });
    expect(card.tagName).toBe('DIV');
    expect(ref.current).toBe(card);
    expect(card).toHaveAttribute('id', 'fuente');
    expect(card).toContainElement(screen.getByRole('heading', { name: 'Conocimiento del negocio' }));
    fireEvent.click(card);
    expect(pulsar).toHaveBeenCalledOnce();
  });

  it('Card no introduce un control de teclado ni un rol interactivo', () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>Fuente</Card>);
    expect(ref.current).not.toHaveAttribute('role');
    expect(ref.current).not.toHaveAttribute('tabindex');
  });

  it('Label conserva htmlFor, ref y activa el control externo al pulsarlo', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLLabelElement>();
    render(<><Label ref={ref} htmlFor="nombre">Nombre de la fuente</Label><input id="nombre" /></>);
    const control = screen.getByRole('textbox', { name: 'Nombre de la fuente' });
    expect(ref.current?.tagName).toBe('LABEL');
    expect(ref.current?.control).toBe(control);
    await user.click(screen.getByText('Nombre de la fuente'));
    expect(control).toHaveFocus();
    await user.type(control, 'Menú');
    expect(control).toHaveValue('Menú');
  });

  it('Label conserva selección de archivo, asociación implícita y foco por teclado', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLInputElement>();
    const cambio = vi.fn();
    render(<Label>Elige un archivo<input ref={ref} type="file" accept="application/pdf" className="sr-only" onChange={cambio} /></Label>);
    const control = screen.getByLabelText('Elige un archivo') as HTMLInputElement;
    expect(ref.current).toBe(control);
    await user.tab();
    expect(control).toHaveFocus();
    const pdf = new File(['%PDF'], 'menu.pdf', { type: 'application/pdf' });
    await user.upload(control, pdf);
    expect(control.files?.[0]).toBe(pdf);
    expect(cambio).toHaveBeenCalledOnce();
  });

  it('los consumidores pueden componer las clases sin perder los atributos nativos', () => {
    const ref = createRef<HTMLLabelElement>();
    render(<Card className="p-6" data-testid="panel"><Label ref={ref} htmlFor="dato" className="text-cuerpo text-action-text">Dato</Label><input id="dato" /></Card>);
    expect(screen.getByTestId('panel')).toHaveClass('rounded-tarjeta', 'bg-raised', 'p-6');
    expect(ref.current).toHaveClass('font-sans', 'text-cuerpo', 'text-action-text');
    expect(ref.current).not.toHaveClass('text-dato');
    expect(ref.current?.control).toBe(screen.getByLabelText('Dato'));
  });
});
