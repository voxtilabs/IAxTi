import type { PoolClient } from 'pg';
import { TIPOS_CRITICOS, type NotificationType } from './notifications';

// Avisos críticos por WhatsApp al PROPIO equipo (#78, SPEC §21): al número
// del vendedor, desde el número del negocio.
//
// Tres reglas que no se negocian:
//  1. Es opt-in: la preferencia nace apagada porque le cuesta plata al
//     negocio y porque WhatsApp es intrusivo.
//  2. Solo avisos CRÍTICOS. El resto vive en la campana y el correo; llenar
//     el WhatsApp del dueño de avisos menores es la forma más rápida de que
//     silencie todos, incluidos los que importan.
//  3. Si el módulo whatsapp está apagado, degrada en silencio (capabilities):
//     el aviso ya quedó en la campana.

export interface DestinatarioEquipo {
  userId: string;
  phone: string;
}

/**
 * Quién pidió recibir este tipo de aviso por WhatsApp y tiene teléfono.
 * Sin teléfono en el perfil no hay a dónde mandar, y no se inventa uno.
 */
export async function teamWhatsAppTargets(
  client: PoolClient,
  tenantId: string,
  type: NotificationType,
  userIds: string[],
): Promise<DestinatarioEquipo[]> {
  if (userIds.length === 0 || !TIPOS_CRITICOS.has(type)) return [];
  const r = await client.query(
    `SELECT p.user_id, p.phone
       FROM notification_preferences np
       JOIN user_profiles p ON p.user_id = np.user_id
      WHERE np.tenant_id = $1 AND np.type = $2 AND np.whatsapp = true
        AND np.user_id = ANY($3::uuid[]) AND p.phone IS NOT NULL`,
    [tenantId, type, userIds],
  );
  return r.rows.map((row) => ({ userId: row.user_id as string, phone: row.phone as string }));
}

export type EnvioEquipo = (input: {
  tenantId: string;
  phone: string;
  texto: string;
}) => Promise<void>;

export interface ResultadoEquipo {
  userId: string;
  enviado: boolean;
  motivo?: string;
}

/**
 * Manda el aviso a cada destinatario. `enviar` lo inyecta quien tenga el
 * canal a mano (el worker), así este módulo no importa whatsapp ni sabe de
 * proveedores. Sin `enviar` —módulo apagado— no pasa nada y se dice por qué.
 */
export async function dispatchTeamWhatsApp(
  client: PoolClient,
  input: {
    tenantId: string;
    type: NotificationType;
    userIds: string[];
    title: string;
    body?: string | null;
    enviar?: EnvioEquipo | null;
  },
): Promise<ResultadoEquipo[]> {
  const destinos = await teamWhatsAppTargets(client, input.tenantId, input.type, input.userIds);
  if (destinos.length === 0) return [];
  if (!input.enviar) {
    return destinos.map((d) => ({
      userId: d.userId,
      enviado: false,
      motivo: 'El canal de WhatsApp está apagado para este negocio.',
    }));
  }
  const texto = input.body ? `${input.title}\n\n${input.body}` : input.title;
  const resultados: ResultadoEquipo[] = [];
  for (const destino of destinos) {
    try {
      await input.enviar({ tenantId: input.tenantId, phone: destino.phone, texto });
      resultados.push({ userId: destino.userId, enviado: true });
    } catch (err) {
      // Fuera de la ventana de 24 h el envío se rechaza hasta que existan
      // plantillas (#44). El aviso igual quedó en la campana y el correo.
      resultados.push({ userId: destino.userId, enviado: false, motivo: (err as Error).message });
    }
  }
  return resultados;
}
