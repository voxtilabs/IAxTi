import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** El helper clásico de shadcn/ui: clases condicionales + merge de Tailwind. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
