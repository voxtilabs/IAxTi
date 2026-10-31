'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { getMode, toggleMode, type PulsoMode } from '../mode';

/** Cambia día/noche y persiste la elección por usuario (Pulso §9/§11). */
export function ModeToggle() {
  const [mode, setModeState] = useState<PulsoMode>('dia');
  useEffect(() => setModeState(getMode()), []);
  return (
    <button
      type="button"
      onClick={() => setModeState(toggleMode())}
      className="pulso-topbar-pill flex items-center gap-2 rounded-full border border-line bg-raised px-4 py-2 text-sm text-ink transition-colors hover:bg-rest"
      aria-label="Cambiar entre modo día y modo noche"
    >
      {mode === 'dia' ? (
        <>
          <Moon className="size-4 shrink-0 text-muted" aria-hidden />
          <span>Modo noche</span>
        </>
      ) : (
        <>
          <Sun className="size-4 shrink-0 text-warn" aria-hidden />
          <span>Modo día</span>
        </>
      )}
    </button>
  );
}
