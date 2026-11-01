'use client';

import Link from 'next/link';
import { Conversacion } from './conversacion';
import { Conversaciones } from './conversaciones';
import { SenalDeLaIa } from './senal-de-la-ia';

/**
 * La pantalla del asistente: la conversación y nada más (#1135).
 *
 * Lo que había antes era el chat arriba y cinco bloques de configuración
 * abajo. El dueño del producto lo probó y dijo que era demasiada información:
 * abrir «Tu asistente» tiene que sentirse como abrir ChatGPT, y desde ahí
 * configurar, contarle del negocio y cargarle cosas.
 *
 * Los bloques se mudaron a `/ajustes/ia/detalle`. Siguen haciendo falta —el
 * agente propone y el humano decide, así que tiene que haber dónde ver qué
 * quedó— pero dejan de competir con la conversación. El enlace de abajo es
 * discreto a propósito: es para cuando alguien quiere revisar, no es la
 * puerta de entrada.
 *
 * Lo único que NO se mudó es la señal de que la IA no puede trabajar. Si se
 * hubiera ido entera, alguien conversaría con un agente que no puede
 * contestar sin saber por qué (#614): acá queda la señal, y el detalle está
 * del otro lado.
 */
export function PantallaDelAsistente() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 py-3">
      {/* El nombre de la pantalla, para quien no la ve (#1163).
          Visible aparecía CUATRO veces en los primeros 300 px: en la barra
          lateral resaltado, en la miga del topbar, en el rótulo y en el
          título. Y los 168 px que ocupaban rótulo y título son 168 px de no
          ver la conversación, en la pantalla cuyo pedido fue «que sea
          literalmente como abrir chatgpt». La miga del topbar dice dónde
          estás, igual que en todas las demás pantallas.
          El `h1` se queda porque la pantalla tiene que tener uno, y
          `densidad` lo sigue midiendo. */}
      <h1 className="sr-only">Tu asistente</h1>
      <SenalDeLaIa />
      <Conversaciones />
      {/* Sin borde ni fondo: el hilo ES la pantalla. Una tarjeta alrededor de
          la conversación la convierte en «un chat dentro de una pantalla»,
          que es exactamente lo que el dueño dijo que no quería. */}
      <section aria-label="Conversación con IAxTi" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Conversacion alto="min-h-0 flex-1" />
      </section>
      <p className="shrink-0 text-center text-dato text-muted">
        <Link href="/ajustes/ia/detalle" className="text-action-text underline">
          Ver lo que quedó configurado
        </Link>
      </p>
    </div>
  );
}
