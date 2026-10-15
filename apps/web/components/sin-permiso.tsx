'use client';

import { EstadoVacio } from '@iaxti/ui/react';

/**
 * Lo que se ve al abrir una pantalla que no es para tu rol (#815).
 *
 * Antes no se veía nada parecido: la pantalla se montaba, pedía sus datos,
 * recibía 403 y lo que la persona terminaba leyendo dependía de cómo cada
 * autor hubiera tratado ese 403 — medido en #588, tres de cinco lo trataron
 * como un fallo genérico, con «intenta de nuevo» incluido. Reintentar no da
 * permisos, así que ese botón no podía funcionar nunca y hacía creer que el
 * producto estaba roto.
 *
 * Está en un componente aparte, y no dentro de `app-shell.tsx`, porque lo usan
 * los dos lados del mismo problema: la guarda de la ruta —que lo dibuja ANTES
 * de montar la pantalla— y una pantalla que igual se comió un 403 porque el
 * permiso le cambió a mitad de sesión (el arranque se pide una vez, así que el
 * conjunto que tiene el navegador puede estar viejo). Si los dos casos no se
 * vieran idénticos, el segundo volvería a leerse como una falla.
 *
 * El camino de vuelta es `/` y no «atrás»: a esta pantalla se suele llegar por
 * un enlace que alguien pasó, y ahí atrás es el chat del que vino.
 */
export function SinPermiso({ que }: { que?: string }) {
  return (
    <EstadoVacio
      titulo="Esto no es para ti"
      descripcion={`${que ? `${que} pide` : 'Esta pantalla pide'} un permiso que tu rol no tiene. No falló nada y no hay nada que reintentar: si lo necesitas para tu trabajo, pídele a quien administra el negocio que te lo dé desde Ajustes.`}
      accion={{ etiqueta: 'Volver al inicio', href: '/' }}
    />
  );
}
