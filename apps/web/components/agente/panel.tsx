'use client';

import { Conversacion } from './conversacion';

/**
 * La conversación con IAxTi, arriba de «Tu asistente» (#1129).
 *
 * ADR-0025 §1.2 lo dice desde el 25/09: «es la vía de configuración
 * universal; todo lo que la API sabe hacer se le puede pedir conversando».
 * El agente estaba construido —195 herramientas filtradas por permiso— y
 * vivía en un popup que había que saber abrir, mientras la pantalla que
 * debía SER esa conversación era una pila de formularios que la mencionaba.
 *
 * Declarado y no aplicado, aplicado a la tesis central del producto.
 *
 * Los paneles de configuración NO se van: quedan abajo. El agente propone un
 * diff y el humano decide, y los paneles son dónde se ve qué quedó. Un chat
 * que configura sin superficie que muestre el resultado no es auditable.
 */
export function PanelDelAgente() {
  return (
    <section
      aria-label="Conversación con IAxTi"
      className="pulso-panel mt-2 flex w-full max-w-seccion flex-col overflow-hidden rounded-tarjeta border border-line bg-raised"
    >
      <Conversacion alto="min-h-[160px] max-h-[min(50vh,420px)]" />
    </section>
  );
}
