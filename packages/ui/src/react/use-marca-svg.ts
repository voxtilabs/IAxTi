'use client';

import { useId } from 'react';

/** Solo SVG de marca versionado, nunca contenido de usuarios.
 * El acceso admin muestra dos firmas: cada una necesita sus propios paint
 * servers para evitar IDs duplicados y referencias a otro SVG (#427). */
export function useMarcaSvg(svg: string): string {
  const id = `voxti-${useId().replace(/:/g, '')}-`;
  return svg.replaceAll('voxti-glass-', id);
}
