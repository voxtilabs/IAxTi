import type { Pool } from 'pg';
import { withTenant } from '@iaxti/db';
import { writeAudit } from '@iaxti/module-audit';
import { PartnerError, type PartnerPorts } from './partner-provider';
import { partnerStatus } from './partner-invitations';

/**
 * El enlace para conectar WhatsApp, por correo (#1259).
 *
 * Hasta ahora el enlace solo salía por `GET /onboarding/whatsapp`, o sea que
 * lo veía quien tenía la pantalla abierta. Y quien abre la cuenta casi nunca
 * es quien tiene el teléfono con el WhatsApp del negocio: la única forma de
 * pasárselo era copiarlo a mano por otro lado.
 *
 * ## Lo que hay que decir en voz alta
 *
 * Ese enlace ES un secreto —se guarda cifrado (ADR-0028) porque con él se
 * engancha un número a este negocio— y mandarlo por correo lo saca de la
 * custodia. Se hace igual, porque así viaja un alta de este tipo en todos los
 * proveedores y porque la alternativa real —copiarlo y pegarlo por WhatsApp—
 * es peor. Lo que lo vuelve aceptable es el cerco: permiso de administración,
 * solo con la invitación en `pending`, con el vencimiento que ya trae, y
 * auditado con el destinatario.
 */
const CORREO = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

export interface EnvioDelEnlace {
  enviado: boolean;
  para: string;
}

export async function enviarElEnlace(
  pool: Pool,
  input: {
    tenantId: string;
    actor: string;
    actorKind: 'user' | 'apikey';
    requestId?: string;
    /** A quién. Sin esto, a quien lo pide. */
    para?: string;
    /** El correo de quien lo pide, para el caso sin destinatario explícito. */
    correoDelActor?: string | null;
    nombreDelNegocio: string;
  },
  ports: PartnerPorts,
  enviar: (correo: { para: string; titulo: string; cuerpo: string; cta: string; enlace: string }) => Promise<boolean>,
): Promise<EnvioDelEnlace> {
  const para = (input.para ?? input.correoDelActor ?? '').trim();
  // Antes de pedir nada: una dirección mal escrita no merece un viaje al
  // proveedor ni una entrada de auditoría que diga que se intentó.
  if (!CORREO.test(para)) {
    throw new PartnerError(
      'CORREO_INVALIDO',
      'Escribe una dirección de correo válida para enviar el enlace.',
      400,
    );
  }

  const estado = await partnerStatus(pool, input.tenantId, ports, {
    tenantId: input.tenantId,
    actor: input.actor,
    actorKind: input.actorKind,
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });

  /**
   * Solo `pending` con enlace. Las otras fases no son un detalle:
   * `active` significa que el número ya está conectado y reenviar invitaría a
   * conectar otro; `expired` mandaría a una página muerta, que es peor que no
   * mandar nada porque quien lo recibe cree que hizo algo mal.
   */
  if (estado.phase !== 'pending' || !estado.url) {
    throw new PartnerError(
      'SIN_ENLACE_QUE_ENVIAR',
      estado.phase === 'active'
        ? 'Este negocio ya tiene su WhatsApp conectado.'
        : 'No hay una conexión pendiente con enlace vigente. Inicia la conexión y vuelve a intentarlo.',
      409,
    );
  }

  const enviado = await enviar({
    para,
    titulo: `Conecta el WhatsApp de ${input.nombreDelNegocio}`,
    cuerpo:
      'Te pidieron conectar el WhatsApp de este negocio a IAxTi. El enlace abre la ' +
      'conexión con Zavu, nuestro proveedor de WhatsApp, y tiene fecha de vencimiento.',
    cta: 'Conectar el WhatsApp',
    enlace: estado.url,
  });

  // Se audita el intento, salga o no: «se mandó» y «se quiso mandar y el
  // correo no está configurado» son dos cosas distintas y las dos hay que
  // poder contarlas después.
  await withTenant(pool, input.tenantId, (c) =>
    writeAudit(c, {
      tenantId: input.tenantId,
      actor: input.actor,
      actorKind: input.actorKind,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      action: 'whatsapp.invitation.link_emailed',
      resource: 'whatsapp_invitation',
      resourceId: estado.id ?? input.tenantId,
      result: enviado ? 'ok' : 'error',
      // El destinatario sí; el enlace NO. Un secreto no se guarda en la
      // auditoría, que es justamente lo que se lee cuando algo salió mal.
      metadata: { para },
    }),
  );

  if (!enviado) {
    throw new PartnerError(
      'CORREO_NO_CONFIGURADO',
      'No pudimos enviar el correo. Avisa a quien configura el servicio.',
      503,
    );
  }
  return { enviado, para };
}
