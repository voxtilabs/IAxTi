import { forwardRef, type LabelHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Adaptado de blocks.so, components/ui/label.tsx (MIT, Ephraim Duncan).
 * https://github.com/ephraimduncan/blocks/blob/3f759d5171c2391253ec4c772e9e5b3db2bc7c7f/components/ui/label.tsx
 * Licencia completa: packages/ui/licenses/blocks.MIT.txt.
 * Cambios: Inter y escala Pulso, disposición inline nativa y foco visible
 * cuando contiene un input sr-only. Clases compatibles con Tailwind 3.4;
 * htmlFor, asociación implícita y ref siguen siendo los de HTML.
 */
export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...props }, ref) {
    return (
      <label
        ref={ref}
        data-slot="label"
        className={cn(
          'font-sans text-dato font-medium focus-within:outline focus-within:outline-2 ' +
            'focus-within:outline-offset-2 focus-within:outline-focus',
          className,
        )}
        {...props}
      />
    );
  },
);
