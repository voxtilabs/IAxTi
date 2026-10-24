// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Chat } from '../components/bandeja/chat';

/**
 * La sugerencia-acción del modo autónomo no ofrece «Enviar sugerencia» (#1030).
 *
 * Cuando el asistente respondió solo, la respuesta YA SALIÓ: lo único
 * pendiente es la acción. La tarjeta con el botón de enviar habría mandado
 * un mensaje vacío — o repetido lo que el cliente ya recibió, que es el
 * defecto de duplicación que más cuesta explicar después. Esto se prueba
 * montando el componente porque es de los que solo se ven al usarlo (#564).
 */

const base = (sugerencia: unknown) =>
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
    sugerencia,
    sinSugerencia: null,
    modo: 'autonomous',
    miId: 'u1',
    aviso: null,
    limitesDeAdjunto: null,
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
    plantillas: [],
    onCargarPlantillas: vi.fn(),
    onEnviarPlantilla: vi.fn(async () => true),
    onAbrirAdjunto: vi.fn(),
  }) as unknown as Parameters<typeof Chat>[0];

const soloAccion = {
  id: 's1',
  text: '',
  confidence: 0.9,
  intent: 'agendar',
  suggestDeal: false,
  accionEnPalabras: 'Agendar una hora con el contacto de esta conversación.',
  herramientas: [],
  fuentes: [],
};

const conTexto = { ...soloAccion, id: 's2', text: 'Hola Rosa, sí tenemos horas el jueves.' };

describe('la sugerencia-acción sin texto (#1030)', () => {
  it('muestra la acción con Confirmar, y NO el botón de enviar', () => {
    render(<Chat {...base(soloAccion)} />);
    expect(screen.getByTestId('confirmar-accion')).toBeInTheDocument();
    expect(screen.queryByTestId('enviar-sugerencia')).toBeNull();
    // El rótulo dice la verdad: la respuesta ya salió.
    expect(screen.getByText(/respondió solo/)).toBeInTheDocument();
  });

  it('con texto, los dos botones están — el camino de assist no cambia', () => {
    render(<Chat {...base(conTexto)} />);
    expect(screen.getByTestId('enviar-sugerencia')).toBeInTheDocument();
    expect(screen.getByTestId('confirmar-accion')).toBeInTheDocument();
    expect(screen.getByText('Hola Rosa, sí tenemos horas el jueves.')).toBeInTheDocument();
  });
});
