'use client';

import { useEffect, useState } from 'react';
import { getMode, toggleMode, type PulsoMode } from '@iaxti/ui';

/** Cambia día/noche y persiste la elección por usuario (Pulso §9/§11). */
export function ModeToggle() {
  const [mode, setModeState] = useState<PulsoMode>('dia');
  useEffect(() => setModeState(getMode()), []);
  return (
    <button
      type="button"
      onClick={() => setModeState(toggleMode())}
      className="rounded-boton border border-line-strong px-5 py-2 text-sm text-ink"
      aria-label="Cambiar entre modo día y modo noche"
    >
      {mode === 'dia' ? 'Modo noche' : 'Modo día'}
    </button>
  );
}
