'use client';

import { useEffect, useState } from 'react';
import { Moon as Luna, Sun as Sol } from 'lucide-react';
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
      className="inline-flex min-h-control min-w-control items-center justify-center rounded-boton px-3 text-sm text-muted transition-colors hover:bg-rest hover:text-ink sm:px-4"
      aria-label="Cambiar entre modo día y modo noche"
    >
      {/*
       * En angosto, el icono (#1127).
       *
       * Era el único control de la barra que no se acortaba, así que a 360 px
       * «Modo noche» se partía en dos líneas — lo único de esa pantalla que
       * envolvía, y encima el texto más largo de la barra. Mismo patrón que
       * «Buscar o ir a…», que ya se acorta a «Buscar».
       *
       * El `aria-label` del botón NO cambia: un icono sin nombre es peor que
       * un texto largo, y acá quien usa lector de pantalla oye lo mismo en
       * las dos anchuras.
       */}
      <span className="hidden sm:inline">{mode === 'dia' ? 'Modo noche' : 'Modo día'}</span>
      {mode === 'dia'
        ? <Luna aria-hidden className="size-5 sm:hidden" />
        : <Sol aria-hidden className="size-5 sm:hidden" />}
    </button>
  );
}
