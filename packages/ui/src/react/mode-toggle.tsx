'use client';

import { useEffect, useState } from 'react';
import { getMode, toggleMode, type PulsoMode } from '../mode';

/** Cambia día/noche y persiste la elección por usuario (Pulso §9/§11). */
export function ModeToggle() {
  const [mode, setModeState] = useState<PulsoMode>('dia');
  useEffect(() => setModeState(getMode()), []);
  return (
    <button
      type="button"
      onClick={() => setModeState(toggleMode())}
      /*
       * Fantasma y no con borde (#1106).
       *
       * Era el ÚNICO control con borde de la barra superior, arriba a la
       * derecha, que es donde cualquier CRM pone su acción principal. O sea:
       * lo visualmente más importante de la aplicación era el conmutador de
       * tema. El peso vuelve al contenido; esto se sigue encontrando porque
       * está donde siempre estuvo.
       */
      className="inline-flex min-h-control items-center rounded-boton px-4 text-sm text-muted transition-colors hover:bg-rest hover:text-ink"
      aria-label="Cambiar entre modo día y modo noche"
    >
      {mode === 'dia' ? 'Modo noche' : 'Modo día'}
    </button>
  );
}
