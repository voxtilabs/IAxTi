import type { HTMLAttributes } from 'react';
import { cn } from './cn';

// Etiquetas por ROL Pulso (§7): color con significado, jamás decorativo.
// Los mismos seis roles del CHECK de la tabla tags (módulo crm).
export type BadgeRole = 'action' | 'good' | 'warn' | 'bad' | 'info' | 'neutral';

const ROLES: Record<BadgeRole, string> = {
  action: 'border-action-soft-br bg-action-soft text-action-text',
  info: 'border-action-soft-br bg-action-soft text-action-text',
  good: 'border-good-soft-br bg-good-soft text-good-text',
  warn: 'border-warn-soft-br bg-warn-soft text-warn-text',
  bad: 'border-bad-soft-br bg-bad-soft text-bad-text',
  neutral: 'border-line bg-rest text-muted',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  role?: BadgeRole;
}

export function Badge({ className, role = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-boton border px-3 py-0.5 text-xs font-medium',
        ROLES[role],
        className,
      )}
      {...props}
    />
  );
}
