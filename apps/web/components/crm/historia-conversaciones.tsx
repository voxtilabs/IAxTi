'use client';

import { Badge, Skeleton } from '@iaxti/ui/react';
import type { ConversacionItem } from '../../lib/api';
import { ESTADOS } from '../bandeja/estado';
import { CanalDelContacto } from './canal-del-contacto';

/** La fecha del último mensaje, sin segundos: no aportan y ocupan (#1395). */
function fechaSinSegundos(iso: string): string {
  const d = new Date(iso);
  // `h23` y no el defecto de la zona: con «a. m.»/«p. m.» la hora de un
  // mensaje ocupa dos datos que nadie pidió.
  return `${d.toLocaleDateString('es-CL')}, ${d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

/**
 * Historia unificada (#32, #1395): TODAS las conversaciones del contacto,
 * resueltas y archivadas incluidas — nada se borra, todo se encuentra.
 *
 * Cada una lleva a la bandeja ABIERTA en esa conversación, y dice su canal con
 * su logo y su nombre legible — antes mostraba la clave cruda del canal
 * («whatsapp», «simulador»), que es cómo la llama el sistema, no cómo la
 * llama quien la usa.
 *
 * La lista la trae quien la usa: la pide una sola vez para toda la pantalla
 * (ficha y botón de «Abrir conversación»), y este componente solo la dibuja.
 */
export function HistoriaConversaciones({ items }: {
  items: ConversacionItem[] | null;
}) {
  return (
    <section>
      <p className="rotulo">Conversaciones</p>
      {items === null ? (
        <div className="mt-2 flex flex-col gap-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Sin conversaciones todavía.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <a
                href={`/bandeja?conversationId=${c.id}`}
                className="flex flex-wrap items-center gap-3 rounded-campo border border-line bg-raised px-4 py-3 transition-colors hover:bg-rest"
              >
                <CanalDelContacto canal={c.channel} />
                <span className="dato ml-auto text-muted">
                  {c.lastMessageAt ? fechaSinSegundos(c.lastMessageAt) : '—'}
                </span>
                <Badge role={ESTADOS[c.state].role}>{ESTADOS[c.state].label}</Badge>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
