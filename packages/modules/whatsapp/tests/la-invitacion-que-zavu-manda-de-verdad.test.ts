import { describe, it, expect } from 'vitest';
import { invitationFrom, PartnerError } from '../application/partner-provider';

/**
 * La forma que Zavu manda DE VERDAD (#1179).
 *
 * Esto es una transcripción, no un ejemplo inventado: es lo que
 * `GET /v1/invitations/{id}` devolvió el 02-11-2026 para una invitación que el
 * panel de Zavu mostraba como completada, con el número ya conectado del lado
 * del proveedor.
 *
 * `partner.test.ts` tiene un Zavu falso que SÍ manda `connectedAccount`, y por
 * eso su suite entera pasaba mientras ninguna invitación real podía
 * completarse. El doble se escribió desde el contrato supuesto, así que
 * confirmaba la suposición. Este archivo existe para que la forma real tenga
 * una prueba propia que no dependa de ese doble.
 */
const COMO_ZAVU_LO_MANDA = {
  invitation: {
    id: 'p174wn62jh3337a7gex60sk7xs8hc408',
    url: 'https://dashboard.zavu.dev/invite/NXDkuePQsd-b0nkN7Xwu6',
    connectionType: 'whatsapp_waba',
    status: 'completed',
    senderId: 'kd7c40p7vkwmt4e33me44edwph8hdxfs',
    connectedAccount: null,
    phoneNumberId: null,
    expiresAt: '2026-11-08T23:30:19.173Z',
    completedAt: '2026-11-01T23:31:15.036Z',
  },
};

const con = (extra: Record<string, unknown>) => ({
  invitation: { ...COMO_ZAVU_LO_MANDA.invitation, ...extra },
});

describe('la invitación que Zavu manda de verdad (#1179)', () => {
  it('una completada sin connectedAccount es válida y conserva el emisor', () => {
    const inv = invitationFrom(COMO_ZAVU_LO_MANDA);
    expect(inv.status).toBe('completed');
    expect(inv.senderId).toBe('kd7c40p7vkwmt4e33me44edwph8hdxfs');
    // El número no se inventa: no vino, así que queda nulo y lo pone la ficha
    // del emisor, que es la fuente de verdad del proveedor.
    expect(inv.phoneNumberId).toBeNull();
  });

  it('sin senderId sigue siendo inválida: es lo único que identifica qué conectar', () => {
    expect(() => invitationFrom(con({ senderId: null }))).toThrow(PartnerError);
    try {
      invitationFrom(con({ senderId: null }));
    } catch (e) {
      expect((e as PartnerError).code).toBe('PARTNER_RESPONSE_INVALID');
    }
  });

  it('si connectedAccount VIENE, su contenido se sigue exigiendo', () => {
    // Lo opcional es que falte, no que mienta. Si Zavu lo manda algún día y
    // trae otro canal, eso es una respuesta que no podemos comprobar.
    expect(() =>
      invitationFrom(con({ connectedAccount: { channel: 'instagram', id: 'x' } })),
    ).toThrow(PartnerError);
    expect(() =>
      invitationFrom(con({ connectedAccount: { channel: 'whatsapp', id: 42 } })),
    ).toThrow(PartnerError);
    // Y la forma completa, que es la que el doble de partner.test.ts usa,
    // sigue siendo válida: el arreglo no cambia ese camino.
    const inv = invitationFrom(
      con({ connectedAccount: { channel: 'whatsapp', id: '1410241985505655' } }),
    );
    expect(inv.phoneNumberId).toBe('1410241985505655');
  });

  it('una pendiente sigue sin exigir emisor', () => {
    const inv = invitationFrom(con({ status: 'pending', senderId: null }));
    expect(inv.status).toBe('pending');
    expect(inv.senderId).toBeNull();
  });

  it('el enlace se sigue comprobando: dominio, ruta y nada colgando', () => {
    // Esta guarda no se toca y conviene que esté acá: si el arreglo del campo
    // opcional aflojara la validación del enlace, se vería.
    for (const url of [
      'https://dashboard.zavu.dev.evil.cl/invite/abc',
      'https://dashboard.zavu.dev/otra/abc',
      'https://dashboard.zavu.dev/invite/abc?x=1',
      'https://user@dashboard.zavu.dev/invite/abc',
    ]) {
      expect(() => invitationFrom(con({ url }))).toThrow(PartnerError);
    }
  });
});
