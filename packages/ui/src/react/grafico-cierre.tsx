'use client';

import { useId } from 'react';

/**
 * El anillo se queda a mano, y es una decisión (#525).
 *
 * Son dos círculos y un `strokeDasharray`: traer el `PieChart` de la librería
 * para esto sería más código y menos control, no menos. La regla de este PR es
 * delegar lo que es un algoritmo —escalas, ticks, ejes—, no delegar por delegar.
 *
 * Y vive en SU archivo, que es lo que descubrí midiendo: mientras compartía
 * archivo con el gráfico de series, importar el anillo desde el barril arrastraba
 * recharts igual, así que la carga diferida no bajaba ni un kilobyte. Un import
 * de tipos no basta para separar dos cosas: hay que separar los archivos.
 */
export function GraficoCierre({ ganadas, perdidas, tasa }: { ganadas: number; perdidas: number; tasa: number | null }) {
  const id = useId();
  const total = ganadas + perdidas;
  const porcentaje = tasa === null ? 0 : tasa * 100;
  return <div className="pulso-chart-ring">
    <svg viewBox="0 0 120 120" role="img" aria-labelledby={id}>
      <title id={id}>{total > 0 ? `${ganadas} oportunidades ganadas y ${perdidas} perdidas` : 'Sin oportunidades cerradas en este período'}</title>
      <circle className="pulso-chart-ring-base" cx="60" cy="60" r="49" />
      {total > 0 && <circle className="pulso-chart-ring-value" cx="60" cy="60" r="49" pathLength="100"
        strokeDasharray={`${porcentaje} ${100 - porcentaje}`} transform="rotate(-90 60 60)" />}
    </svg>
    <div aria-hidden="true"><strong className="font-mono">{total > 0 ? `${Math.round(porcentaje)}%` : '—'}</strong><span>de cierre</span></div>
  </div>;
}
