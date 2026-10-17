import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Adaptado de blocks.so, components/ui/card.tsx (MIT, Ephraim Duncan).
 * https://github.com/ephraimduncan/blocks/blob/3f759d5171c2391253ec4c772e9e5b3db2bc7c7f/components/ui/card.tsx
 * Licencia completa: packages/ui/licenses/blocks.MIT.txt.
 * Cambios: radio tarjeta, colores y tipografía Pulso; clases Tailwind 3.4.
 * El contenido decide su espaciado. Sin la sintaxis v4, sombras ni secciones
 * adicionales del original que esta pantalla no necesita. Ref y atributos
 * nativos, igual que Input: Card conserva la semántica de un div.
 */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card"
        className={cn('rounded-tarjeta border border-line bg-raised font-sans text-ink', className)}
        {...props}
      />
    );
  },
);
