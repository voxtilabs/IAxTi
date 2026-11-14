'use client';

import type { AnalisisDto } from '../../lib/api';

/**
 * La boleta del asistente (Mesón, ADR-0034 · #1346).
 *
 * Es el «momento» de la bandeja: lo que el asistente hizo por este cliente,
 * escrito como se escribe en un mesón —papel, letra de caja, una línea por
 * cosa y un timbre—. La idea no es decorar: con un bot de WhatsApp gratis en
 * cualquier teléfono (Meta Business Agent), lo que IAxTi tiene que mostrar es
 * que su asistente deja COMPROBANTE de lo que hace.
 *
 * Sale solo de `analisis.acciones`, que la API ya mandaba y la ficha mostraba
 * como una lista gris. No inventa líneas: sin acciones no hay boleta, y el
 * timbre aparece solo si el asistente de verdad está respondiendo solo.
 */
export function BoletaDelAsistente({
  acciones,
  modo,
  hoy = new Date(),
}: {
  acciones: AnalisisDto['acciones'];
  modo: AnalisisDto['mode'];
  hoy?: Date;
}) {
  if (acciones.length === 0) return null;
  const fecha = hoy.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return (
    <div
      className="boleta rounded-t-[6px] bg-[var(--paper)] px-4 pt-4 font-mono text-xs leading-[18px] text-[var(--paper-ink)]"
      aria-label="Lo que hizo el asistente"
      role="group"
    >
      <p className="mb-2.5 flex justify-between text-[var(--paper-muted)]">
        <span>Asistente IAxTi</span>
        <span>{fecha}</span>
      </p>
      <ul className="flex flex-col">
        {acciones.slice(0, 5).map((a, i) => (
          <li key={`${a.at}-${i}`} className="grid grid-cols-[44px_1fr] gap-2 py-1">
            <span className="text-[var(--paper-muted)]">
              {new Date(a.at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
            </span>
            <span>
              <span className="block font-medium">{a.que}</span>
              <span className="block text-[var(--paper-muted)]">
                {a.estado}
                {a.feedback ? ` · ${a.feedback === 'up' ? 'sirvió' : 'no sirvió'}` : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {modo === 'autonomous' && (
        <span className="mt-3 inline-block -rotate-3 rounded border-[1.5px] border-action-text px-2 font-medium text-action-text">
          Piloto automático
        </span>
      )}
    </div>
  );
}
