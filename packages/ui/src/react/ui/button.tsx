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

const TAMANOS: Record<ButtonSize, string> = {
  normal: 'h-control px-6 text-cuerpo',
  chico: 'h-9 px-4 text-sm',
  icono: 'h-9 w-9 p-0',
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
