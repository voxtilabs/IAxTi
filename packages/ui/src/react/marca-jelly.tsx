'use client';

import { useId } from 'react';
import { cn } from './ui/cn';

// La geometría es la del isotipo oficial de IAxTi, no la de VOXIA.
// El material vive en tokens; cada instancia tiene IDs propios (SSR incluido).
const ISOTIPO = 'M 9.062057426658498,54.00999999999999 L 155.5020574266585,180.45 A 34,34 0 0,0 199.9420574266585,128.99 L 53.502057426658496,2.5500000000000114 A 34,34 0 0,0 9.062057426658498,54.00999999999999 M 155.5020574266585,2.5500000000000114 L 9.062057426658498,128.99 A 34,34 0 0,0 53.502057426658496,180.45 L 199.9420574266585,54.00999999999999 A 34,34 0 0,0 155.5020574266585,2.5500000000000114';

/** Marca decorativa: el nombre accesible lo da el enlace o título que acompaña. */
export function MarcaJelly({ className }: { className?: string }) {
  const id = `jelly-${useId().replace(/:/g, '')}`;
  return (
    <svg className={cn('pulso-jelly', className)} viewBox="-24 -20 264 242" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <path id={`${id}-shape`} d={ISOTIPO} />
        <linearGradient id={`${id}-material`} x1="18" y1="0" x2="164" y2="198" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--jelly-ice)" />
          <stop offset=".16" stopColor="var(--jelly-sky)" />
          <stop offset=".43" stopColor="var(--action)" />
          <stop offset=".78" stopColor="var(--jelly-deep)" />
          <stop offset="1" stopColor="var(--jelly-shadow)" />
        </linearGradient>
        <radialGradient id={`${id}-light`}>
          <stop stopColor="var(--jelly-glint)" stopOpacity=".96" />
          <stop offset=".28" stopColor="var(--jelly-ice)" stopOpacity=".85" />
          <stop offset=".62" stopColor="var(--jelly-sky)" stopOpacity=".55" />
          <stop offset="1" stopColor="var(--jelly-sky)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-edge`} x1="0" y1="0" x2=".85" y2="1">
          <stop stopColor="var(--jelly-glint)" stopOpacity=".95" />
          <stop offset=".5" stopColor="var(--jelly-ice)" stopOpacity=".1" />
          <stop offset="1" stopColor="var(--jelly-sky)" stopOpacity=".5" />
        </linearGradient>
        <clipPath id={`${id}-clip`}><use href={`#${id}-shape`} /></clipPath>
        <filter id={`${id}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        {/* El filete se obtiene del alfa unido: no dibuja costuras en el cruce. */}
        <filter id={`${id}-rim`} x="-5%" y="-5%" width="110%" height="110%">
          <feMorphology in="SourceAlpha" operator="erode" radius="1.6" result="interior" />
          <feComposite in="SourceGraphic" in2="interior" operator="out" />
        </filter>
      </defs>
      <use href={`#${id}-shape`} transform="translate(3 7)" fill="var(--jelly-shadow)" opacity=".88" />
      <use href={`#${id}-shape`} fill={`url(#${id}-material)`} />
      <g clipPath={`url(#${id}-clip)`}>
        <ellipse cx="33" cy="28" rx="43" ry="34" fill={`url(#${id}-light)`} />
        <ellipse cx="172" cy="28" rx="39" ry="32" fill={`url(#${id}-light)`} />
        <ellipse cx="178" cy="145" rx="42" ry="36" fill={`url(#${id}-light)`} />
        <ellipse cx="43" cy="144" rx="32" ry="35" fill={`url(#${id}-light)`} opacity=".75" />
        <path d="M14 30 Q15 5 40 12 M165 12 Q185 9 196 28" stroke="var(--jelly-glint)" strokeWidth="4" strokeLinecap="round" opacity=".85" filter={`url(#${id}-soft)`} />
        <path d="M19 23 Q22 14 35 16 M170 16 Q181 15 188 22" stroke="var(--jelly-glint)" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M177 171 Q195 167 200 149 M20 156 Q30 174 48 174" stroke="var(--jelly-sky)" strokeWidth="5" strokeLinecap="round" opacity=".7" filter={`url(#${id}-soft)`} />
      </g>
      <use href={`#${id}-shape`} fill={`url(#${id}-edge)`} filter={`url(#${id}-rim)`} />
    </svg>
  );
}
