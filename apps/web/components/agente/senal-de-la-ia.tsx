'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { apiFetch } from '../../lib/api';
import { useSelectedTenant } from '../tenant-switcher';
import { useAgente } from './estado';

interface PasoDto {
  id: string;
  titulo: string;
  estado: 'bien' | 'mal' | 'atencion' | 'desconocido';
  detalle: string;
}

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
 * `problema` NO es una frase: es `roto?.id`, el identificador del paso. La
 * primera versión lo pintaba tal cual y el aviso decía «proveedores», una
 * palabra suelta sobre fondo rojo. El texto humano está en el `titulo` y el
 * `detalle` del paso que coincide con ese id.
 *
 * Y esto NO usa `AvisoResultado`: ese componente lanza SIEMPRE un toast, y
 * con `persistente` además dibuja el bloque. Para un aviso de resultado está
 * bien —algo acaba de pasar—, pero esto es un estado permanente: saldría un
 * toast rojo cada vez que alguien entra a conversar, y un aviso que aparece
 * en cada visita se vuelve parte del fondo.
 */
export function SenalDeLaIa() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const { iaRota } = useAgente();
  const [pasos, setPasos] = useState<PasoDto[]>([]);

  useEffect(() => {
    if (!session || !tenant || !iaRota) {
      setPasos([]);
      return;
    }
    let vigente = true;
    void apiFetch<{ problema: string | null; pasos: PasoDto[] }>(
      config, session, tenant, '/agents/diagnostico',
    )
      .then((r) => {
        if (!vigente) return;
        setPasos(r.pasos ?? []);
      })
      // En silencio: un aviso de que no pudimos revisar el estado, encima de
      // un chat que capaz funciona perfecto, enseña a ignorar los avisos.
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [config, session, tenant, iaRota]);

  // El «está rota» lo decide el PROVEEDOR (#1326): señal y campo leen el
  // mismo dato en vez de dos fetches del mismo endpoint. Acá solo se busca
  // el paso que explica el problema, para decirlo con palabras humanas.
  if (!iaRota) return null;
  const roto = pasos.length ? pasos[0] : null;
  return (
    <p
      role="status"
      className="shrink-0 rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-dato text-bad-text"
    >
      {roto ? (
        <>
          <strong className="font-semibold">{roto.titulo}:</strong> {roto.detalle}{' '}
        </>
      ) : (
        'La IA no puede contestar ahora. '
      )}
      <Link href="/ajustes/ia/detalle" className="underline">
        Ver qué falta
      </Link>
    </p>
  );
}
