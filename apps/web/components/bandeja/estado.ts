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

/**
 * Las prioridades, con lo que significan (#550).
 *
 * `conversations.priority` existía desde la primera migración y la API la
 * devolvía en cada conversación: nadie podía cambiarla ni ordenar por ella, así
 * que todo se veía «normal» y no había nada que lo explicara.
 *
 * **El color no es el único portador** (regla Pulso): cada una lleva su palabra,
 * y `normal` no lleva insignia — una lista donde todo tiene etiqueta es una
 * lista sin etiquetas. Lo que se marca es lo que se sale de lo normal.
 *
 * El `ayuda` va en el selector, no en la insignia: decide quién pone qué, y sin
 * eso «alta» y «urgente» terminan queriendo decir lo mismo.
 */
export const PRIORIDADES: Array<{
  valor: ConversacionItem['priority'];
  label: string;
  role: BadgeRole;
  ayuda: string;
}> = [
  {
    valor: 'urgente',
    label: 'Urgente',
    role: 'bad',
    ayuda: 'Atender antes que todo lo demás: un reclamo, algo que se puede perder hoy.',
  },
  {
    valor: 'alta',
    label: 'Alta',
    role: 'warn',
    ayuda: 'Sube en la lista, pero no interrumpe lo que estás haciendo.',
  },
  { valor: 'normal', label: 'Normal', role: 'neutral', ayuda: 'El orden de siempre, por actividad.' },
  {
    valor: 'baja',
    label: 'Baja',
    role: 'neutral',
    ayuda: 'Puede esperar: una consulta sin apuro, alguien que solo mira.',
  },
];

/** La insignia de una conversación, o null si es `normal`. */
export function insigniaDePrioridad(
  prioridad: ConversacionItem['priority'] | undefined,
): { label: string; role: BadgeRole } | null {
  if (!prioridad || prioridad === 'normal') return null;
  const p = PRIORIDADES.find((x) => x.valor === prioridad);
  return p ? { label: p.label, role: p.role } : null;
}
