// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chat, type ChatProps } from '../components/bandeja/chat';

function props(channel: string, abierta: boolean): ChatProps {
  return {
    detalle: { id: 'conversacion-ficticia', contactId: 'contacto-ficticio', contactName: 'Cliente ficticio', contactPhone: null,
      channel, state: 'open', ownerId: null, lastInboundAt: new Date().toISOString(), ventanaAbierta: abierta,
      lastMessageAt: null, unansweredSeconds: null, snoozedUntil: null, priority: 'normal', contactEmail: null,
      contactOptInAt: null, contactOptInChannel: null, contactOptInEvidence: null, contactOptedOutAt: null, firstResponseAt: null },
    mensajes: [], atajos: [], sugerencia: null, sinSugerencia: null, modo: 'off', miId: 'operador', aviso: null,
    limitesDeAdjunto: { canal: channel, limites: [] }, reintentando: null, plantillas: [],
    onVolver: vi.fn(), onVerFicha: vi.fn(), onResponder: vi.fn().mockResolvedValue(true), onAsignar: vi.fn(), onEstado: vi.fn(),
    onPrioridad: vi.fn(), onSugerencia: vi.fn(), onReintentar: vi.fn(), onModo: vi.fn(), onCobrar: vi.fn(),
    onCrearOportunidad: vi.fn(), onCargarPlantillas: vi.fn(), onEnviarPlantilla: vi.fn(), onAbrirAdjunto: vi.fn(),
  };
}
describe('Bandeja Meta conserva capacidades reales (#74)', () => {
  it.each(['instagram', 'messenger'])('%s permite texto pero no selector ni pegar adjuntos', async (kind) => {
    const p = props(kind, true); render(<Chat {...p} />);
    expect(screen.getByText('Esta conexión solo permite enviar texto por este canal.')).toBeVisible();
    expect(screen.queryByLabelText('Adjuntar un archivo')).not.toBeInTheDocument();
    const campo = screen.getByRole('textbox', { name: 'Mensaje' });
    fireEvent.paste(campo, { clipboardData: { files: [new File(['ficticio'], 'foto.png', { type: 'image/png' })], items: [] } });
    await userEvent.type(campo, 'Texto permitido');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(p.onResponder).toHaveBeenCalledWith('Texto permitido', undefined);
    expect(screen.queryByText('foto.png')).not.toBeInTheDocument();
  });
  it.each(['instagram', 'messenger'])('%s con ventana cerrada no ofrece plantillas de WhatsApp', (kind) => {
    render(<Chat {...props(kind, false)} />);
    expect(screen.getByText(/Podrás responder cuando vuelva a escribirte por este canal/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Mensaje' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Elegir plantilla/ })).not.toBeInTheDocument();
  });
  it('WhatsApp conserva su entrada a plantillas fuera de ventana', () => {
    render(<Chat {...props('whatsapp', false)} />);
    expect(screen.getByRole('button', { name: /Elegir plantilla/ })).toBeVisible();
  });
});
