import type { HTMLAttributes } from 'react';
import { cn } from './cn';
import { IconoPersona } from './icons';

// Avatar de iniciales (sin fotos en Fase 2): círculo suave de la familia acción.
export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  nombre?: string | null;
  size?: 'chico' | 'normal';
}

/**
 * Las iniciales de un nombre, o `null` cuando no hay nombre.
 *
 * Antes, sin nombre, caía a los dos últimos caracteres del `fallback` — que en
 * la bandeja es el teléfono, así que los círculos decían «48», «30», «91».
 * Eso hay que decodificarlo, parece un contador, y no distingue a nadie: tres
 * conversaciones nuevas se ven como tres números sueltos.
 *
 * Devuelve `null` y no una cadena para que quien pinta decida: el avatar
 * muestra una silueta neutra, y encima en la superficie de descanso y no en el
 * relleno de acción — ese azul es el más saturado de la bandeja y estaba
 * gastado en el dato menos útil de la fila.
 */
export function iniciales(nombre?: string | null): string | null {
  if (!nombre?.trim()) return null;
  const partes = nombre.trim().split(/\s+/);
  return ((partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? '')).toUpperCase() || null;
}

export function Avatar({ nombre, size = 'normal', className, ...props }: AvatarProps) {
  const letras = iniciales(nombre);
  return (
    <div
      aria-hidden
      className={cn(
        'pulso-avatar flex shrink-0 select-none items-center justify-center rounded-boton',
        'font-display font-bold',
        letras
          ? 'border border-action-soft-br bg-action-soft text-action-text'
          : 'border border-line bg-rest text-muted',
        size === 'chico' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm',
        className,
      )}
      {...props}
    >
      {letras ?? <IconoPersona className={size === 'chico' ? 'h-4 w-4' : 'h-5 w-5'} />}
    </div>
  );
}
