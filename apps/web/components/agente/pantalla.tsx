'use client';

import Link from 'next/link';
import { EncabezadoDePagina } from '@iaxti/ui/react';
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-3">
      {/* El encabezado se queda, compacto (#1125): la pantalla sigue teniendo
          que empezar como las demás, y sin él volvía a no tener `h1`. */}
      <EncabezadoDePagina rotulo="Asistente" titulo="Tu asistente" className="shrink-0 mb-0" />
      <SenalDeLaIa />
      <Conversaciones />
      <section
        aria-label="Conversación con IAxTi"
        className="pulso-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-tarjeta border border-line bg-raised"
      >
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
