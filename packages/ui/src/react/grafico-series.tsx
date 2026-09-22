'use client';

import { useId, useState } from 'react';

export interface SerieGrafico {
  nombre: string;
  valores: number[];
  tono: 'action' | 'good' | 'warn';
}

/** Escala común, desde cero, con cuatro intervalos legibles. */
export function techoDeEscala(maximo: number): number {
  if (maximo <= 0) return 4;
  const bruto = maximo / 4;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const paso = [1, 2, 5, 10].find((n) => n * potencia >= bruto)! * potencia;
  return Math.max(4, paso * 4);
}

/** SVG de datos, sin librería pesada, interpolación ni animación de cifras. */
export function GraficoSeries({ etiquetas, series, titulo }: {
  etiquetas: string[]; series: SerieGrafico[]; titulo: string;
}) {
  const id = useId();
  const [elegido, setElegido] = useState<number | null>(null);
  if (etiquetas.length === 0) return null;
  const activo = Math.min(elegido ?? etiquetas.length - 1, etiquetas.length - 1);
  const techo = techoDeEscala(Math.max(0, ...series.flatMap((s) => s.valores)));
  const x = (i: number) => etiquetas.length === 1 ? 500 : i * 1000 / (etiquetas.length - 1);
  const y = (n: number) => 200 - n / techo * 200;
  const posiciones = [...new Set([0, Math.floor((etiquetas.length - 1) / 2), etiquetas.length - 1])];
  return <figure className="pulso-chart">
    <div className="pulso-chart-legend" aria-label="Series del gráfico">
      {series.map((s, i) => <span key={s.nombre} data-serie={s.tono}>
        <i aria-hidden="true" className={i === 1 ? 'pulso-chart-dashed' : undefined} />{s.nombre}
      </span>)}
    </div>
    <div className="pulso-chart-frame">
      <div className="pulso-chart-scale font-mono" aria-hidden="true">
        {[4, 3, 2, 1, 0].map((n) => <span key={n}>{new Intl.NumberFormat('es-CL').format(techo * n / 4)}</span>)}
      </div>
      <div className="pulso-chart-plot" onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setElegido(Math.max(0, Math.min(etiquetas.length - 1,
          Math.round((event.clientX - rect.left) / rect.width * (etiquetas.length - 1)))));
      }}>
        <svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
          <title id={`${id}-title`}>{titulo}</title>
          <desc id={`${id}-desc`}>Evolución diaria, escala desde cero hasta {techo}. Usa el selector de día o abre la tabla para leer todos los valores.</desc>
          {[0, 50, 100, 150, 200].map((n) => <line className="pulso-chart-grid" key={n} x1="0" x2="1000" y1={n} y2={n} vectorEffect="non-scaling-stroke" />)}
          {series.map((s, i) => {
            const puntos = s.valores.map((valor, dia) => `${x(dia)},${y(valor)}`).join(' ');
            return <g key={s.nombre} data-serie={s.tono}>
              {i === 0 && <polygon className="pulso-chart-area" points={`0,200 ${puntos} 1000,200`} />}
              <polyline className="pulso-chart-line" points={puntos} fill="none" strokeDasharray={i === 1 ? '6 4' : undefined} vectorEffect="non-scaling-stroke" />
            </g>;
          })}
          <line className="pulso-chart-guide" x1={x(activo)} x2={x(activo)} y1="0" y2="200" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="pulso-chart-dates font-mono" aria-hidden="true">{posiciones.map((i) => <span key={i}>{etiquetas[i]}</span>)}</div>
      </div>
    </div>
    <label className="pulso-chart-selector">
      <span className="sr-only">Elegir día del gráfico</span>
      <input type="range" min="0" max={etiquetas.length - 1} step="1" value={activo}
        aria-valuetext={`${etiquetas[activo]}: ${series.map((s) => `${s.valores[activo]} ${s.nombre.toLowerCase()}`).join(', ')}`}
        onChange={(e) => setElegido(Number(e.target.value))} />
    </label>
    <figcaption className="pulso-chart-reading" aria-live="polite" aria-atomic="true">
      <strong className="font-mono">{etiquetas[activo]}</strong>
      {series.map((s) => <span key={s.nombre} data-serie={s.tono}><b className="font-mono">{s.valores[activo]}</b> {s.nombre.toLowerCase()}</span>)}
    </figcaption>
  </figure>;
}

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
