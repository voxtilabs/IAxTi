'use client';

import { useId, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

export interface SerieGrafico {
  nombre: string;
  valores: number[];
  tono: 'action' | 'good' | 'warn';
}

/**
 * El trazado y las escalas los hace Recharts (#525).
 *
 * Antes eran 89 líneas de SVG a mano, con su propia escala y sus propios ejes.
 * Dentro vivía esto:
 *
 * ```ts
 * const potencia = 10 ** Math.floor(Math.log10(bruto));
 * const paso = [1, 2, 5, 10].find((n) => n * potencia >= bruto)! * potencia;
 * ```
 *
 * Un algoritmo de «ticks bonitos» mantenido por nosotros, resuelto en cualquier
 * librería de gráficos desde hace quince años, y con un caso raro a la vista: con
 * un máximo entre 0 y 4 devolvía 4, así que un negocio con 1 conversación y uno
 * con 4 veían el mismo gráfico. Eso se fue con la función.
 *
 * Lo que NO se delegó, y conviene decir por qué: la accesibilidad de acá es mejor
 * que la de Recharts. El `figure` con su `desc`, el selector de día por teclado y
 * la lectura en `aria-live` se quedan tal cual, y la librería se ocupa solo del
 * dibujo (`accessibilityLayer` apagado: duplicaría lo que ya hace el selector).
 * Cambiar eso por los tooltips de la librería habría sido perder en la dimensión
 * que más importa en una aplicación de negocio, a cambio de menos código.
 *
 * Los colores salen de `currentColor` y de variables, no de una paleta de la
 * librería: es lo primero que rompe Pulso, y la guarda de hex lo caza.
 */

/**
 * Sobre los días en cero y los huecos: el issue pedía distinguirlos, y **no
 * corresponde con estos datos**. La API devuelve la serie densa, y un día sin
 * conversaciones tuvo cero conversaciones — eso es un dato, no una ausencia.
 * Un hueco sería para un día que el sistema no midió, y eso no pasa acá.
 * Dibujar un hueco donde hay un cero sería inventar una duda que no existe.
 */
export function GraficoSeries({ etiquetas, series, titulo }: {
  etiquetas: string[]; series: SerieGrafico[]; titulo: string;
}) {
  const id = useId();
  const [elegido, setElegido] = useState<number | null>(null);
  if (etiquetas.length === 0) return null;
  const activo = Math.min(elegido ?? etiquetas.length - 1, etiquetas.length - 1);
  const datos = etiquetas.map((etiqueta, i) => {
    const fila: Record<string, string | number> = { etiqueta };
    series.forEach((s, j) => { fila[`s${j}`] = s.valores[i] ?? 0; });
    return fila;
  });
  const posiciones = [...new Set([0, Math.floor((etiquetas.length - 1) / 2), etiquetas.length - 1])];
  const numero = new Intl.NumberFormat('es-CL');
  return <figure className="pulso-chart">
    <div className="pulso-chart-legend" aria-label="Series del gráfico">
      {series.map((s, i) => <span key={s.nombre} data-serie={s.tono}>
        <i aria-hidden="true" className={i === 1 ? 'pulso-chart-dashed' : undefined} />{s.nombre}
      </span>)}
    </div>
    {/* El `role="img"` y las descripciones van en el contenedor y no en el SVG
        de la librería: el SVG lo dibuja Recharts y no es nuestro para etiquetar.
        Los textos son los mismos de antes, menos el techo de la escala, que
        ahora lo elige la librería y no hay por qué recitarlo. */}
    <div className="pulso-chart-plot" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <p className="sr-only" id={`${id}-title`}>{titulo}</p>
      <p className="sr-only" id={`${id}-desc`}>
        Evolución diaria desde cero. Usa el selector de día o abre la tabla para leer todos los valores.
      </p>
      <ResponsiveContainer height={220} width="100%">
        <ComposedChart
          data={datos}
          margin={{ bottom: 0, left: 0, right: 4, top: 4 }}
          // `activeTooltipIndex` viene como `number | string | undefined` en la
          // librería, así que se comprueba el tipo en vez de confiar: un índice
          // que llegue como texto movería el guía a NaN y no se vería nada.
          onMouseMove={(estado) => {
            if (typeof estado.activeTooltipIndex === 'number') setElegido(estado.activeTooltipIndex);
          }}
        >
          {/* Ni color ni tamaño acá: los pone `pulso-vivo.css` sobre las clases
              que genera la librería. Un `fill` o un `fontSize` en el componente
              es exactamente lo que Pulso prohíbe —el componente no tiene por qué
              saber en qué modo está— y además los 11 px de los ejes ya estaban
              en el CSS desde antes de este cambio. */}
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="etiqueta"
            interval={0}
            tickFormatter={(valor: string) => (posiciones.includes(etiquetas.indexOf(valor)) ? valor : '')}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            // Desde cero SIEMPRE: una escala que empieza en el mínimo exagera
            // cualquier variación, y acá son los números de un negocio.
            domain={[0, 'auto']}
            tickFormatter={(valor: number) => numero.format(valor)}
            tickLine={false}
            width={44}
          />
          <ReferenceLine className="pulso-chart-guide" strokeDasharray="3 5" x={etiquetas[activo]} />
          {series.map((s, i) => (i === 0 ? (
            <Area
              dataKey={`s${i}`}
              dot={false}
              fill="var(--action-soft)"
              isAnimationActive={false}
              key={s.nombre}
              // `currentColor` no sirve dentro del SVG de la librería: el trazo
              // se pinta por tono, con la misma variable que usa la leyenda.
              stroke={`var(--${s.tono}-text)`}
              strokeWidth={3}
              type="linear"
            />
          ) : (
            <Line
              dataKey={`s${i}`}
              dot={false}
              isAnimationActive={false}
              key={s.nombre}
              stroke={`var(--${s.tono}-text)`}
              strokeDasharray="6 4"
              strokeWidth={3}
              type="linear"
            />
          )))}
        </ComposedChart>
      </ResponsiveContainer>
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
