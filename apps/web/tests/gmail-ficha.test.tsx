// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  context: {
    config: { apiUrl: 'https://api.example.test' },
    session: { access_token: 'test-session', user: { id: 'user-a' } },
  },
  pieza: { estado: 'ok', dato: [] },
}));
vi.mock('@iaxti/ui/react', async original => ({
  ...await original<object>(), useSession: () => auth.context,
}));
vi.mock('../components/tenant-switcher', () => ({ useSelectedTenant: () => 'tenant-a' }));
vi.mock('../components/arranque', () => ({
  usePieza: () => auth.pieza,
  useArranque: () => ({ arranque: {
    permisos: ['integrations.read', 'integrations.connect'], modulos: [{ id: 'integrations' }],
  } }),
}));

import { FichaContacto } from '../components/crm/ficha-contacto';
import type { FichaContacto as Ficha } from '../lib/api';

const ficha: Ficha = {
  contact: {
    id: 'contact-a', name: 'Contacto de prueba', phone: '+56970000000',
    email: 'contact@example.test', rut: null, origin: 'whatsapp',
    opt_in_at: null, opted_out_at: null, last_activity_at: '2026-01-01T12:00:00Z',
    created_at: '2026-01-01T12:00:00Z', custom: {}, company_id: null, company_name: null,
  },
  deals: [], activities: [],
};
const etiquetas: [] = [];
const send = vi.fn<typeof fetch>();
beforeEach(() => {
  send.mockReset().mockImplementation(async () => Response.json({
    configured: true, status: 'disconnected', pushActive: false, lastNotificationAt: null,
  }));
  vi.stubGlobal('fetch', send);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('abrir la ficha compacta de la bandeja no monta Gmail ni agrega peticiones', async () => {
  render(<FichaContacto contactId={ficha.contact.id} compacta precargada={ficha} etiquetasPrecargadas={etiquetas} />);
  await screen.findByText('Actividades');
  expect(screen.queryByText('Correo de Gmail')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('la ficha completa de CRM conserva Gmail y su lectura de estado con el SDK real', async () => {
  render(<FichaContacto contactId={ficha.contact.id} precargada={ficha} etiquetasPrecargadas={etiquetas} />);
  await screen.findByText('Sin conectar');
  expect(screen.getByText('Correo de Gmail')).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
  expect(String(send.mock.calls[0][0])).toBe('https://api.example.test/v1/integraciones/gmail');
  expect(new Headers(send.mock.calls[0][1]?.headers).get('X-Tenant-Id')).toBe('tenant-a');
});
