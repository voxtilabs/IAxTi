'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from './cn';
import { IconoCheck } from './icons';

/**
 * Checkbox de shadcn en Pulso (#293).
 *
 * Lo que vino del registro traía tres cosas que no son de acá y que se
 * cambiaron, no se "adaptaron":
 *
 *  - `shadow`. Un checkbox no flota; la única sombra del sistema es para lo
 *    que se superpone (ADR-0018). El guard de sombras lo caza.
 *  - `border-primary`, o sea el azul de acción siempre. En Pulso el borde
 *    de un control en reposo es el filete fuerte; el azul aparece cuando
 *    está marcado, que es cuando significa algo.
 *  - `focus-visible:ring-1 ring-ring`. El foco de Pulso es anillo de 2 con
 *    `--action`, igual que el Select, para que todos los controles se
 *    enfoquen igual.
 *
 * El cuadro mide 18 px pero el área que recibe el clic la pone quien lo
 * usa, envolviéndolo en su `<label>`: así el texto también marca.
 */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'grid size-[18px] shrink-0 place-content-center rounded-[6px] border border-line-strong bg-bg',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-action',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-action data-[state=checked]:bg-action data-[state=checked]:text-white',
        'data-[state=indeterminate]:border-action data-[state=indeterminate]:bg-action data-[state=indeterminate]:text-white',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center text-current">
        {props.checked === 'indeterminate' ? (
          // Selección parcial: una raya, no un check a medias.
          <span aria-hidden className="block h-0.5 w-2.5 rounded-full bg-current" />
        ) : (
          <IconoCheck className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});
