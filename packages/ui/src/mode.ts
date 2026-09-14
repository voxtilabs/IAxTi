export type PulsoMode = 'dia' | 'noche';

const STORAGE_KEY = 'pulso-mode';

/**
 * Script inline para el <head>: fija data-mode ANTES del primer render (sin
 * destello). Inicial por prefers-color-scheme; si el usuario ya eligió,
 * manda su elección persistida (documento Pulso §9/§11).
 */
export const MODE_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('${STORAGE_KEY}');if(m!=='dia'&&m!=='noche'){m=window.matchMedia('(prefers-color-scheme: dark)').matches?'noche':'dia';}document.documentElement.dataset.mode=m;}catch(e){document.documentElement.dataset.mode='dia';}})();`;

export function getMode(): PulsoMode {
  if (typeof document === 'undefined') return 'dia';
  return document.documentElement.dataset.mode === 'noche' ? 'noche' : 'dia';
}

/** Cambia el modo y lo persiste por usuario (localStorage). */
export function setMode(mode: PulsoMode): void {
  document.documentElement.dataset.mode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // sin almacenamiento disponible: el modo igual queda aplicado
  }
}

export function toggleMode(): PulsoMode {
  const next: PulsoMode = getMode() === 'dia' ? 'noche' : 'dia';
  setMode(next);
  return next;
}
