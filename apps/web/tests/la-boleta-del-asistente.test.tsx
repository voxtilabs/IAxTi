// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BoletaDelAsistente } from '../components/bandeja/boleta-del-asistente';

/**
 * La boleta del asistente (Mesón, #1346).
 *
 * Se prueba montándola porque la pregunta es de comportamiento —«con estas
 * acciones, ¿qué se ve?»— y no «¿está escrito?» (#564). Lo que importa es que
 * la boleta NO invente: una línea por acción real, nada si no hay acciones, y
 * el timbre solo cuando el asistente de verdad responde solo.
 */
const acciones = [
  { at: '2026-11-13T17:02:00.000Z', que: 'Respondió stock', estado: 'enviada', feedback: null },
  { at: '2026-11-13T17:05:00.000Z', que: 'Agendó una visita', estado: 'confirmada', feedback: 'up' },
];

describe('la boleta del asistente', () => {
  it('dibuja una línea por cada acción, con lo que hizo y en qué quedó', () => {
    render(<BoletaDelAsistente acciones={acciones} modo="assist" />);
    const boleta = screen.getByRole('group', { name: 'Lo que hizo el asistente' });
    expect(boleta.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Respondió stock')).toBeTruthy();
    expect(screen.getByText('Agendó una visita')).toBeTruthy();
    expect(screen.getByText(/confirmada · sirvió/)).toBeTruthy();
  });

  it('sin acciones no hay boleta: un papel vacío diría que trabajó', () => {
    const { container } = render(<BoletaDelAsistente acciones={[]} modo="autonomous" />);
    expect(container.innerHTML).toBe('');
  });

  it('el timbre de piloto automático sale solo si responde solo', () => {
    const { rerender } = render(<BoletaDelAsistente acciones={acciones} modo="assist" />);
    expect(screen.queryByText('Piloto automático')).toBeNull();
    rerender(<BoletaDelAsistente acciones={acciones} modo="autonomous" />);
    expect(screen.getByText('Piloto automático')).toBeTruthy();
  });

  it('nunca muestra más de cinco líneas', () => {
    const muchas = Array.from({ length: 8 }, (_, i) => ({ ...acciones[0], at: `2026-11-13T17:0${i}:00.000Z`, que: `Acción ${i}` }));
    render(<BoletaDelAsistente acciones={muchas} modo="assist" />);
    expect(screen.getByRole('group').querySelectorAll('li')).toHaveLength(5);
  });
});
