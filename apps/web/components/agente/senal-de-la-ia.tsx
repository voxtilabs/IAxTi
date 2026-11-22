'use client';

import Link from 'next/link';
import { useAgente } from './estado';

/**
 * Que la IA no puede trabajar, dicho ANTES de escribirle (#1135, #614).
 *
 * El panel de diagnóstico se mudó a `/ajustes/ia/detalle` con el resto de la
 * configuración. Si se hubiera ido entero, alguien le escribiría a un agente
 * que no puede contestar y recibiría un error genérico sin saber por qué —que
 * es justo lo que #614 arregló al poner la causa antes del gráfico en cero.
 *
 * Acá queda la SEÑAL y allá el detalle. Una línea, no un panel: en una
 * pantalla cuyo trabajo es conversar, un diagnóstico desplegado vuelve a ser
 * lo que el dueño del producto pidió sacar.
 *
 * ## Dos cosas que aprendí escribiendo esto
 *
 * El dato sale del PROVEEDOR (`useAgente`), no de un fetch propio (#1326):
 * el diagnóstico de esta pantalla ya se pidió una vez para saber si el campo
 * acepta texto, y pedirlo otra vez acá para poder redactar el aviso era el
 * viaje repetido que el issue vino a sacar. Sin paso roto no hay señal —
 * tampoco hay frase de respaldo: un aviso genérico que no dice QUÉ falla
 * manda a la pantalla de detalle igual que el que sí, pero enseñó menos en
 * el camino.
 *
 * Y esto NO usa `AvisoResultado`: ese componente lanza SIEMPRE un toast, y
 * con `persistente` además dibuja el bloque. Para un aviso de resultado está
 * bien —algo acaba de pasar—, pero esto es un estado permanente: saldría un
 * toast rojo cada vez que alguien entra a conversar, y un aviso que aparece
 * en cada visita se vuelve parte del fondo.
 */
export function SenalDeLaIa() {
  const { pasoRoto } = useAgente();
  if (!pasoRoto) return null;
  return (
    <p
      role="status"
      className="shrink-0 rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-dato text-bad-text"
    >
      <strong className="font-semibold">{pasoRoto.titulo}:</strong> {pasoRoto.detalle}{' '}
      <Link href="/ajustes/ia/detalle" className="underline">
        Ver qué falta
      </Link>
    </p>
  );
}
