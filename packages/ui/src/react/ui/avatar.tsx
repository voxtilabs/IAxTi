import type { HTMLAttributes } from 'react';
import { cn } from './cn';

// Avatar de iniciales (sin fotos en Fase 2): círculo suave de la familia acción.
export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  nombre?: string | null;
  /** Cae al teléfono cuando el contacto aún no tiene nombre. */
  fallback?: string;
  size?: 'chico' | 'normal';
}

export function iniciales(nombre?: string | null, fallback = '?'): string {
  if (!nombre?.trim()) return fallback.replace(/[^0-9A-Za-z+]/g, '').slice(-2) || '?';
  const partes = nombre.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function Avatar({ nombre, fallback = '?', size = 'normal', className, ...props }: AvatarProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'pulso-avatar flex shrink-0 select-none items-center justify-center rounded-boton',
        'border border-action-soft-br bg-action-soft font-display font-bold text-action-text',
        size === 'chico' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm',
        className,
      )}
      {...props}
    >
      {iniciales(nombre, fallback)}
    </div>
  );
}
