// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chat } from '../components/bandeja/chat';

/**
 * «No elegiste nada» y «estoy abriendo la que elegiste» son dos estados (#1111).
 *
 * `seleccion` se pone en el clic y `detalle` llega después del fetch, así que
 * en el intervalo había `seleccion` sin `detalle` — y el panel mostraba «Elige
 * una conversación de la lista» MIENTRAS traía la que acababas de elegir. Le
 * decía al usuario que su clic no entró, justo cuando una conexión lenta es la
 * razón de que esté mirando ese texto.
 *
 * Esto se prueba montando el componente y no en e2e a propósito: en e2e el
 * estado dura lo que dura un fetch contra localhost, así que la prueba se
 * vuelve una carrera y lo que mide es la velocidad de la máquina. Acá el
 * estado es un dato (#564).
 */
const base = {
  detalle: null,
  mensajes: null,
  atajos: [],
  sugerencia: null,
  sinSugerencia: null,
  modo: 'copilot',
  miId: 'u1',
  aviso: null,
  limitesDeAdjunto: null,
  plantillas: [],
  onVolver: vi.fn(),
  onVerFicha: vi.fn(),
  onResponder: vi.fn(async () => true),
  onAsignar: vi.fn(async () => true),
  onEstado: vi.fn(async () => true),
  onPrioridad: vi.fn(async () => true),
  onSugerencia: vi.fn(),
  onModo: vi.fn(),
  onCobrar: vi.fn(async () => true),
  onCrearOportunidad: vi.fn(async () => true),
  onCargarPlantillas: vi.fn(),
  onEnviarPlantilla: vi.fn(async () => true),
  onAbrirAdjunto: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('el panel del chat sin detalle', () => {
  it('sin selección invita a elegir, sin enseñar atajos de teclado', () => {
    render(<Chat {...base} />);
    expect(screen.getByText(/Elige una conversación de la lista/)).toBeTruthy();
    // La chuleta salió de acá en #1165. Estaba porque «el espacio que queda
    // es la mitad de la pantalla: que sirva de algo», y era cierto mientras
    // la bandeja abría sin nada elegido. Ahora abre con la primera puesta, y
    // este panel solo aparece cuando la bandeja está VACÍA: a quien todavía
    // no recibió un mensaje, `j / k` no le sirve de nada. Sigue detrás del «?».
    expect(screen.queryByText('Para ir más rápido')).toBeNull();
    expect(screen.queryByText('Siguiente / anterior conversación')).toBeNull();
  });

  it('con una elegida y el detalle en vuelo, dice que la está trayendo', () => {
    render(<Chat {...base} abriendo />);
    expect(screen.getByText('Estamos trayendo la conversación.')).toBeTruthy();
    // Lo que NO puede decir: que no elegiste nada.
    expect(screen.queryByText(/Elige una conversación/)).toBeNull();
    // Y no deja los atajos puestos encima de algo que ya está en camino.
    expect(screen.queryByText('Para ir más rápido')).toBeNull();
  });
});
