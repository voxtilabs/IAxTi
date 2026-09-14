import type { BadgeRole } from '@iaxti/ui/react';
import type { ConversacionItem } from '../../lib/api';

// Estados de conversación en voz Pulso, con su rol de color (SPEC §11/§29).
export const ESTADOS: Record<ConversacionItem['state'], { label: string; role: BadgeRole }> = {
  new: { label: 'Nueva', role: 'warn' },
  open: { label: 'En curso', role: 'action' },
  pending: { label: 'Esperando', role: 'neutral' },
  resolved: { label: 'Resuelta', role: 'good' },
  snoozed: { label: 'Pospuesta', role: 'neutral' },
};

export function fmtEspera(segundos: number): string {
  if (segundos < 60) return 'ahora';
  if (segundos < 3600) return `${Math.floor(segundos / 60)} min`;
  if (segundos < 86_400) return `${Math.floor(segundos / 3600)} h`;
  return `${Math.floor(segundos / 86_400)} d`;
}
