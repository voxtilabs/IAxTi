import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

// Campos Pulso (§6): 46 px, radio 14, borde fuerte, placeholder tenue.
const CAMPO =
  'w-full rounded-campo border border-line-strong bg-field px-4 text-cuerpo text-ink ' +
  'placeholder:text-faint transition-colors focus:border-focus disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(CAMPO, 'h-control', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={cn(CAMPO, 'min-h-control py-3 leading-relaxed', className)} {...props} />
  );
});
