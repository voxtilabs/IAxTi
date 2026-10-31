import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

// Botón shadcn-style en vocabulario Pulso (§5): pastilla 999, alto 46,
// una sola acción primaria por pantalla. Sin dark:; los tokens cambian solos.
export type ButtonVariant = 'primario' | 'secundario' | 'fantasma' | 'destructivo' | 'soft';
export type ButtonSize = 'normal' | 'chico' | 'icono';

const VARIANTES: Record<ButtonVariant, string> = {
  primario: 'bg-action text-white hover:bg-action-hover',
  secundario: 'border border-line-strong bg-transparent text-ink hover:bg-rest',
  fantasma: 'bg-transparent text-body hover:bg-rest',
  destructivo: 'bg-bad text-white hover:opacity-90',
  soft: 'border border-action-soft-br bg-action-soft text-action-text hover:border-action',
};

/**
 * `chico` e `icono` llegan a 44 px, no a 36 (#1106).
 *
 * Medido sobre /contactos a 1280: cincuenta de ochenta y nueve blancos de
 * interacción quedaban bajo 44×44, y casi todos salían de acá — `h-9` son
 * 36 px. El mínimo táctil no es una preferencia: es el tamaño con el que un
 * pulgar acierta, y la persona que usa esto está en el celular contestando
 * entre clienta y clienta.
 *
 * «Chico» sigue siendo chico donde importa, que es el ANCHO y el peso visual;
 * lo que sube es el alto, que no se ve y sí se toca.
 */
const TAMANOS: Record<ButtonSize, string> = {
  normal: 'h-control px-6 text-cuerpo',
  chico: 'h-11 px-4 text-sm',
  icono: 'h-11 w-11 p-0',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primario', size = 'normal', type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      data-size={size}
      className={cn(
        'pulso-button inline-flex select-none items-center justify-center gap-2 rounded-boton font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        VARIANTES[variant],
        TAMANOS[size],
        className,
      )}
      {...props}
    />
  );
});
