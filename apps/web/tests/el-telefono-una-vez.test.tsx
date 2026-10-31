// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chat } from '../components/bandeja/chat';

/**
 * La cabecera del chat no repite el teléfono (#1120).
 *
 * Se cuenta, no se mira: el defecto era que la misma cadena salía dos veces
 * una encima de la otra, y «se ve raro» no es una aserción. Con la ficha
 * haciendo lo mismo a quince centímetros, el mismo número aparecía cuatro
 * veces en la pantalla donde se pasa el día.
 */
const TELEFONO = '+56955550101';
const base = (name: string | null) =>
  ({
    detalle: {
      id: 'c1',
      contactName: name,
      contactPhone: TELEFONO,
      contact: { id: 'k1', name, phone: TELEFONO },
      state: 'open',
      channel: 'whatsapp',
      ventana24h: { abierta: true, cierraEn: null },
    },
    mensajes: [],
    atajos: [],
    sugerencia: null,
    sinSugerencia: null,
    modo: null,
    miId: 'u1',
    aviso: null,
    limitesDeAdjunto: null,
    plantillas: [],
    onVolver: vi.fn(), onVerFicha: vi.fn(),
    onResponder: vi.fn(async () => true), onAsignar: vi.fn(async () => true),
    onEstado: vi.fn(async () => true), onPrioridad: vi.fn(async () => true),
    onSugerencia: vi.fn(), onModo: vi.fn(),
    onCobrar: vi.fn(async () => true), onCrearOportunidad: vi.fn(async () => true),
    onCargarPlantillas: vi.fn(), onEnviarPlantilla: vi.fn(async () => true),
    onAbrirAdjunto: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('la cabecera del chat', () => {
  it('sin nombre, el teléfono se ve UNA vez', () => {
    const { container } = render(<Chat {...base(null)} />);
    const cabecera = container.querySelector('.pulso-chat-contact');
    expect(cabecera).not.toBeNull();
    expect(cabecera!.textContent).toBe(TELEFONO);
  });

  it('con nombre, el teléfono sigue debajo', () => {
    render(<Chat {...base('Ana Pérez')} />);
    expect(screen.getByText('Ana Pérez')).toBeTruthy();
    expect(screen.getAllByText(TELEFONO).length).toBeGreaterThan(0);
  });
});
