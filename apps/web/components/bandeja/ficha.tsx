'use client';

import { Avatar, Badge, Button, IconoVolver } from '@iaxti/ui/react';
import type { ConversacionDetalle } from '../../lib/api';
import { ESTADOS, fmtEspera } from './estado';

function Fila({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-3">
      <p className="rotulo">{rotulo}</p>
      <div className="mt-1 text-sm text-body">{children}</div>
    </div>
  );
}

/** Panel derecho (SPEC §11): la ficha mínima; la completa llega con #32. */
export function Ficha({
  detalle,
  onVolver,
}: {
  detalle: ConversacionDetalle | null;
  onVolver: () => void;
}) {
  if (!detalle) {
    return <p className="p-6 text-sm text-muted">La ficha del contacto aparece al elegir una conversación.</p>;
  }
  const consentimiento = detalle.contactOptedOutAt
    ? { role: 'bad' as const, label: 'Pidió no recibir mensajes' }
    : detalle.contactOptInAt
      ? { role: 'good' as const, label: 'Dio su consentimiento' }
      : { role: 'neutral' as const, label: 'Escribió primero' };

  return (
    <div className="p-6">
      <Button variant="fantasma" size="chico" className="mb-4 md:hidden" onClick={onVolver}>
        <IconoVolver className="h-4 w-4" /> Volver al chat
      </Button>
      <div className="flex items-center gap-3">
        <Avatar nombre={detalle.contactName} fallback={detalle.contactPhone} />
        <div className="min-w-0">
          <p className="truncate font-display font-bold text-ink">
            {detalle.contactName ?? 'Sin nombre aún'}
          </p>
          <p className="dato text-muted">{detalle.contactPhone}</p>
        </div>
      </div>

      <div className="mt-6">
        <Fila rotulo="Consentimiento">
          <Badge role={consentimiento.role}>{consentimiento.label}</Badge>
        </Fila>
        <Fila rotulo="Estado">
          <Badge role={ESTADOS[detalle.state].role}>{ESTADOS[detalle.state].label}</Badge>
        </Fila>
        {detalle.contactEmail && <Fila rotulo="Correo">{detalle.contactEmail}</Fila>}
        <Fila rotulo="Canal">{detalle.channel}</Fila>
        {detalle.unansweredSeconds !== null && (
          <Fila rotulo="Esperando respuesta">
            <span className="dato text-warn-text">{fmtEspera(detalle.unansweredSeconds)}</span>
          </Fila>
        )}
        <Fila rotulo="Primera respuesta">
          {detalle.firstResponseAt ? (
            <span className="dato">{new Date(detalle.firstResponseAt).toLocaleString('es-CL')}</span>
          ) : (
            'Todavía sin responder'
          )}
        </Fila>
      </div>

      <p className="mt-6 text-xs text-muted">
        La ficha completa — oportunidades, actividades y campos del negocio — llega con la
        siguiente parte del CRM.
      </p>
    </div>
  );
}
