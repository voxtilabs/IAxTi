// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueHayQueHacer } from '../components/crm/oportunidades';
import type { DealCardDto } from '../lib/api';

/**
 * Lo que la tarjeta DICE en cada estado (#1302).
 *
 * Montada y no leída como fuente: la pregunta es «¿qué ve quien mira el
 * tablero?», y eso solo lo contesta renderizar (#564). La guarda de fuente no
 * puede decir que una ranura muestre dos cosas a la vez ni que el plural esté
 * bien.
 *
 * El estado llega CALCULADO del servidor —el navegador no conoce la zona del
 * negocio— así que acá se prueba la decisión de qué mostrar, que es lo único
 * que vive de este lado.
 */
const base: DealCardDto = {
  id: 'd1',
  createdAt: '2026-11-01T12:00:00Z',
  title: 'Venta',
  status: 'open',
  stageId: 's1',
  stageName: 'Nuevo',
  value: 1000,
  currency: 'CLP',
  valueClp: 1000,
  stalled: false,
  ownerId: null,
  wonAt: null,
  lostAt: null,
  contactId: 'c1',
  contactName: 'Persona',
  contactPhone: '+56911112222',
  proximaActividad: null,
};

const conProxima = (p: DealCardDto['proximaActividad'], extra: Partial<DealCardDto> = {}) =>
  ({ ...base, proximaActividad: p, ...extra }) satisfies DealCardDto;

describe('qué dice la tarjeta (#1302)', () => {
  it('sin nada agendado lo dice: es la tarjeta de la que nadie se hace cargo', () => {
    render(<QueHayQueHacer deal={base} />);
    expect(screen.getByText('Sin agendar')).toBeTruthy();
  });

  it('atrasada dice cuántos días, y en singular cuando es uno', () => {
    const { unmount } = render(
      <QueHayQueHacer deal={conProxima({ title: 'x', dueAt: null, estado: 'atrasada', dias: 3 })} />,
    );
    expect(screen.getByText('Atrasada 3 días')).toBeTruthy();
    unmount();
    render(
      <QueHayQueHacer deal={conProxima({ title: 'x', dueAt: null, estado: 'atrasada', dias: 1 })} />,
    );
    expect(screen.getByText('Atrasada 1 día')).toBeTruthy();
  });

  it('la que vence hoy tiene su propia palabra, no «atrasada 0 días»', () => {
    render(<QueHayQueHacer deal={conProxima({ title: 'x', dueAt: null, estado: 'hoy', dias: null })} />);
    expect(screen.getByText('Vence hoy')).toBeTruthy();
  });

  it('atrasada le gana a estancada: una nombra lo que alguien dejó pasar ayer', () => {
    render(
      <QueHayQueHacer
        deal={conProxima({ title: 'x', dueAt: null, estado: 'atrasada', dias: 2 }, { stalled: true })}
      />,
    );
    expect(screen.getByText('Atrasada 2 días')).toBeTruthy();
    expect(screen.queryByText('Estancada')).toBeNull();
  });

  it('estancada sigue apareciendo cuando no hay nada más urgente que decir', () => {
    render(<QueHayQueHacer deal={{ ...base, stalled: true }} />);
    expect(screen.getByText('Estancada')).toBeTruthy();
  });

  it('una futura no grita: dice en cuántos días y en apagado', () => {
    render(<QueHayQueHacer deal={conProxima({ title: 'x', dueAt: null, estado: 'proxima', dias: 5 })} />);
    expect(screen.getByText(/En/).textContent).toContain('5');
    // El número en mono, que es la regla para todo plazo en Pulso.
    expect(screen.getByText('5').className).toContain('dato');
  });

  it('una cerrada no tiene próximo paso y no muestra nada', () => {
    const { container } = render(
      <QueHayQueHacer
        deal={conProxima({ title: 'x', dueAt: null, estado: 'atrasada', dias: 9 }, {
          status: 'won',
          stalled: true,
        })}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
