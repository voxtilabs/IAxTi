import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Los tamaños propios no son colores: `text-dato text-ink` conserva ambos.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['titulo', 'seccion', 'cuerpo', 'dato', 'rotulo'] }] } },
});

/** El helper clásico de shadcn/ui: clases condicionales + merge de Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
