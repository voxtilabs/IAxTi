'use client';

import { useEffect, useState } from 'react';
import { Button } from '@iaxti/ui/react';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useAgente } from './estado';

/**
 * Mis conversaciones anteriores (#1131).
 *
 * Lo pidió el dueño del producto: «que sea como abrir ChatGPT o Claude desde
 * el celular y pueda ver mis anteriores conversaciones». Pedir la función es
 * elegir guardarlas — no hay historial con un hilo en memoria— y eso es lo
 * que decidió ADR-0029.
 *
 * Son PERSONALES: lo que una persona le contó al agente no aparece en la
 * pantalla de otra, aunque compartan negocio.
 *
 * No es una barra lateral fija. En escritorio sobraría ancho que la
 * conversación usa mejor, y en el teléfono una barra lateral es una pantalla
 * entera escondida detrás de un gesto. Es un desplegable sobre el chat: se
 * abre cuando se busca algo viejo, que es cuando hace falta.
 */
export function Conversaciones() {
  const { hilos, pedirHilos, abrirHilo, olvidarHilo, nuevaConversacion, turnos } = useAgente();
  const [abierta, setAbierta] = useState(false);

  useEffect(() => {
    if (abierta && hilos === null) pedirHilos();
  }, [abierta, hilos, pedirHilos]);

  const cuantas = hilos?.length ?? 0;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Button
        variant="fantasma"
        size="chico"
        aria-expanded={abierta}
        onClick={() => setAbierta((v) => !v)}
      >
        <Clock aria-hidden className="size-4" />
        Conversaciones
      </Button>
      {/* «Nueva» solo con algo escrito: en una pantalla ya vacía no hace
          nada, y un botón que no hace nada enseña a no mirar los botones. */}
      {turnos.length > 0 && (
        <Button variant="fantasma" size="chico" onClick={nuevaConversacion}>
          <Plus aria-hidden className="size-4" />
          Nueva
        </Button>
      )}

      {abierta && (
        <div className="w-full">
          {hilos === null ? (
            <p className="ayuda">Buscando tus conversaciones…</p>
          ) : cuantas === 0 ? (
            /* Sin acción propia a propósito: lo que la llena es escribir
               abajo, que ya está ahí. Un botón «empezar» sería un segundo
               camino al mismo campo. */
            <p className="ayuda">
              Todavía no hay ninguna. Las de acá abajo se guardan solas y vuelven cuando las
              necesites.
            </p>
          ) : (
            <ul className="flex w-full flex-col gap-1">
              {hilos.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void abrirHilo(h.id)}
                    className="min-h-control min-w-0 flex-1 rounded-campo px-3 text-left text-dato text-body transition-colors hover:bg-rest hover:text-ink"
                  >
                    <span className="block truncate">{h.titulo}</span>
                  </button>
                  <Button
                    variant="quitar"
                    size="icono"
                    aria-label={`Borrar la conversación «${h.titulo}»`}
                    onClick={() => void olvidarHilo(h.id)}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
