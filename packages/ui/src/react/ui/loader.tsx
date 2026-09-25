import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * `Loader` de los AI Elements del AI SDK de Vercel (registro oficial
 * `https://registry.ai-sdk.dev/loader.json`), tal cual: no tiene colores
 * propios —hereda `currentColor`— así que no hubo nada que tematizar.
 *
 * Respeta `prefers-reduced-motion` por la clase de Tailwind, que es lo que
 * Pulso exige de cualquier cosa que se mueva.
 */
export type LoaderProps = HTMLAttributes<HTMLDivElement> & { size?: number };

const IconoLoader = ({ size = 16 }: { size?: number }) => (
  <svg height={size} width={size} viewBox="0 0 16 16" strokeLinejoin="round" style={{ color: 'currentcolor' }} aria-hidden>
    <g clipPath="url(#pulso-loader)">
      <path d="M8 0V4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 16V12" opacity="0.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.29773 1.52783L5.64887 4.7639" opacity="0.9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.7023 1.52783L10.3511 4.7639" opacity="0.1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.7023 14.472L10.3511 11.236" opacity="0.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.29773 14.472L5.64887 11.236" opacity="0.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.6085 5.52783L11.8043 6.7639" opacity="0.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M0.391602 10.472L4.19583 9.23598" opacity="0.7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.6085 10.4722L11.8043 9.2361" opacity="0.3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M0.391602 5.52783L4.19583 6.7639" opacity="0.8" stroke="currentColor" strokeWidth="1.5" />
    </g>
    <defs>
      <clipPath id="pulso-loader">
        <rect height="16" width="16" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <div
    className={cn('inline-flex animate-spin items-center justify-center motion-reduce:animate-none', className)}
    {...props}
  >
    <IconoLoader size={size} />
  </div>
);
