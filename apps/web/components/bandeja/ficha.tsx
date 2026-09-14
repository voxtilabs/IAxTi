'use client';

import { useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  CanalChip,
  IconoVolver,
  Textarea,
  nombreCanal,
  nombreVisible,
} from '@iaxti/ui/react';
import type { AnalisisDto, ConversacionDetalle, NotaDto } from '../../lib/api';
import { FichaContacto } from '../crm/ficha-contacto';
import { ESTADOS, fmtEspera } from './estado';
import { SecuenciasFicha } from './secuencias-ficha';
import { RetencionAviso } from './retencion-aviso';

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
  notas,
  analisis,
  onVolver,
  onAgregarNota,
}: {
  detalle: ConversacionDetalle | null;
  notas: NotaDto[];
  analisis: AnalisisDto | null;
  onVolver: () => void;
  onAgregarNota: (texto: string) => Promise<void>;
}) {
  const [nota, setNota] = useState('');
  const [guardando, setGuardando] = useState(false);
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
        <Avatar nombre={detalle.contactName} fallback={detalle.contactPhone ?? nombreCanal(detalle.channel)} />
        <div className="min-w-0">
          <p className="truncate font-display font-bold text-ink">
            {detalle.contactName ?? nombreVisible({ phone: detalle.contactPhone, channel: detalle.channel })}
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
        <Fila rotulo="Canal"><CanalChip canal={detalle.channel} /></Fila>
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

      {/* Notas internas (SPEC §11): visibles SOLO para el equipo. */}
      <div className="mt-6">
        <p className="rotulo">Notas del equipo</p>
        {notas.length === 0 && (
          <p className="mt-2 text-sm text-muted">Sin notas todavía. El cliente jamás las ve.</p>
        )}
        <ul className="mt-2 flex flex-col gap-2">
          {notas.map((n) => (
            <li key={n.id} className="rounded-campo border border-warn-soft-br bg-warn-soft p-3">
              <p className="whitespace-pre-wrap text-sm text-ink">{n.body}</p>
              <p className="dato mt-1 text-warn-text">
                {new Date(n.createdAt).toLocaleString('es-CL')}
              </p>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!nota.trim() || guardando) return;
            setGuardando(true);
            void onAgregarNota(nota.trim()).then(() => {
              setNota('');
              setGuardando(false);
            });
          }}
        >
          <Textarea
            aria-label="Nota interna"
            placeholder="Nota para el equipo (con @menciones)…"
            rows={2}
            value={nota}
            onChange={(e) => setNota(e.target.value)}
          />
          <Button type="submit" variant="secundario" size="chico" disabled={!nota.trim() || guardando}>
            Guardar nota
          </Button>
        </form>
      </div>

      {/* Secuencias (#63): el seguimiento como proceso visible. */}
      <SecuenciasFicha contactId={detalle.contactId} conversationId={detalle.id} />

      {/* Retención (#77): desde cuándo no hay historial. */}
      <RetencionAviso />

      {/* La lectura de la IA (#48): resumen, intención y calificación. */}
      {analisis && (analisis.summary || analisis.intent || analisis.acciones.length > 0) && (
        <div className="mt-6 rounded-campo border border-line bg-rest p-4">
          <p className="rotulo">Lectura de la IA</p>
          {analisis.summary && <p className="mt-2 text-sm text-body">{analisis.summary}</p>}
          <p className="mt-2 flex flex-wrap gap-2">
            {analisis.mode === 'autonomous' && <Badge role="warn">✦ Piloto automático</Badge>}
            {analisis.intent && <Badge role="action">{analisis.intent}</Badge>}
            {analisis.leadScore && (
              <Badge role={analisis.leadScore === 'caliente' ? 'good' : analisis.leadScore === 'tibio' ? 'warn' : 'neutral'}>
                Lead {analisis.leadScore}
              </Badge>
            )}
          </p>
          {analisis.acciones.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {analisis.acciones.slice(0, 5).map((a, i) => (
                <li key={i} className="text-xs text-muted">
                  <span className="dato">{new Date(a.at).toLocaleString('es-CL')}</span> · {a.que}
                  {' '}({a.estado}{a.feedback ? `, ${a.feedback === 'up' ? '👍' : '👎'}` : ''})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* La MISMA ficha del CRM (#32): oportunidades y actividades aquí. */}
      <div className="mt-6 border-t border-line pt-4">
        <FichaContacto contactId={detalle.contactId} compacta />
        <a href={`/contactos/${detalle.contactId}`} className="mt-4 inline-block text-sm text-action-text">
          Abrir la ficha completa →
        </a>
      </div>
    </div>
  );
}
