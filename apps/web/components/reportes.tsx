'use client';

import { useState } from 'react';
import { CheckCheck, Clock3, MessageSquare, MessagesSquare, RefreshCw, type LucideIcon } from 'lucide-react';
import {
  AvisoResultado, Badge, Button, EncabezadoDePagina, EstadoVacio, GraficoCierre,
  Skeleton, Tabs, TabsList, TabsTrigger,
} from '@iaxti/ui/react';
import dynamic from 'next/dynamic';
import { PreguntaALosNumeros } from './pregunta-a-los-numeros';
import { useReporte } from './use-reporte';
import { fmtClp } from '../lib/api';
import { diasDelReporte, fechaReporte } from '../lib/reportes';

/**
 * El gráfico se carga cuando hace falta, no antes (#525).
 *
 * Recharts pesa ~150 kB y esta es la única pantalla que lo usa. Importándolo
 * derecho, la primera carga de reportes pasaba de 499 a 648 kB — y el motivo por
 * el que estos gráficos estaban escritos a mano era justamente el peso, así que
 * pagarlo en silencio habría sido cambiar un problema por otro.
 *
 * Diferirlo no cuesta nada aquí: la pantalla ya muestra esqueletos mientras pide
 * los datos, así que el gráfico nunca es lo primero que se ve. `ssr: false`
 * porque el trazado necesita medir el ancho del contenedor, que en el servidor
 * no existe: renderizarlo allá da un gráfico de cero píxeles que después salta.
 */
const GraficoSeries = dynamic(
  () => import('@iaxti/ui/react/grafico').then((m) => m.GraficoSeries),
  {
    ssr: false,
    // Del alto exacto del gráfico, para que la página no dé un salto al llegar.
    loading: () => <Skeleton className="h-[220px] w-full" />,
  },
);

const RANGOS = [7, 30, 90];
const numero = new Intl.NumberFormat('es-CL');
function fmtSeg(seg: number | null): string {
  if (seg === null) return '—';
  if (seg < 60) return `${seg} s`;
  if (seg < 3600) return `${Math.round(seg / 60)} min`;
  return `${(seg / 3600).toFixed(1)} h`;
}

function Cifra({ rotulo, valor, definicion, alerta, icono: Icono, amplia }: {
  rotulo: string; valor: string; definicion?: string; alerta?: boolean; icono?: LucideIcon; amplia?: boolean;
}) {
  return <article className={`pulso-report-metric pulso-panel rounded-tarjeta border border-line bg-raised ${amplia ? 'col-span-2 sm:col-span-1' : ''}`} title={definicion}>
    <h3 className="pulso-report-metric-label">{Icono && <Icono aria-hidden="true" />}{rotulo}</h3>
    <strong className={`pulso-report-metric-value font-mono ${alerta ? 'text-warn-text' : 'text-ink'}`}>{valor}</strong>
    {definicion && <details className="pulso-report-definition"><summary>Qué mide</summary><p>{definicion}</p></details>}
  </article>;
}

export function Reportes() {
  const [dias, setDias] = useState(30);
  const { tenant, datos, rango, actualizado, cargando, aviso, reintentar } = useReporte(dias);
  const m = datos?.metrics;
  const d = datos?.definiciones;
  const serie = datos ? diasDelReporte(datos.porDia, rango.from, rango.to) : [];
  const movimiento = serie.some((dia) => dia.conversaciones > 0 || dia.resueltas > 0 || dia.oportunidades > 0);
  const etiquetas = serie.map((dia) => fechaReporte(dia.day));

  return <section className="mx-auto max-w-5xl" aria-label="Reportes del negocio">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <EncabezadoDePagina rotulo="REPORTES" titulo="Cómo va el negocio" />
      <Tabs value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
        <TabsList aria-label="Período del reporte">{RANGOS.map((r) => <TabsTrigger key={r} value={String(r)}>{r} días</TabsTrigger>)}</TabsList>
      </Tabs>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted">Conversaciones, resultados y recursos de tu negocio.</p>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span role="status">{cargando ? 'Actualizando datos…' : actualizado ? `Actualizado ${actualizado.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        <Button variant="fantasma" aria-label="Actualizar reportes" onClick={reintentar} disabled={cargando || !tenant}>
          <RefreshCw aria-hidden="true" className="size-4" /> Actualizar
        </Button>
      </div>
    </div>
    {aviso && <div className="mt-3"><AvisoResultado tono="error" persistente>{aviso} Puedes volver a intentar con Actualizar.</AvisoResultado></div>}
    {!tenant ? <p className="mt-4 text-muted">Elige un negocio en el selector.</p> : !datos || !m || !d ? (
      cargando && <div className="mt-5 space-y-4" aria-label="Cargando reportes"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{RANGOS.concat(1).map((n) => <Skeleton key={n} className="h-36" />)}</div><Skeleton className="h-80" /></div>
    ) : <div aria-busy={cargando}>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Cifra rotulo="Conversaciones" valor={numero.format(m.conversaciones_nuevas)} definicion={d.conversaciones_nuevas} icono={MessagesSquare} />
        <Cifra rotulo="Resueltas" valor={numero.format(m.resueltas)} definicion={d.resueltas} icono={CheckCheck} />
        <Cifra rotulo="Sin responder ahora" valor={numero.format(datos.sinResponderAhora)} definicion={d.sin_responder_ahora} alerta={datos.sinResponderAhora > 0} icono={MessageSquare} />
        <Cifra rotulo="1ª respuesta (mediana)" valor={fmtSeg(datos.primeraRespuesta.medianaSeg)} icono={Clock3}
          definicion={`${d.primera_respuesta} (${datos.primeraRespuesta.muestras} conversaciones medidas; p90 ${fmtSeg(datos.primeraRespuesta.p90Seg)})`} />
      </div>

      <section className="pulso-panel mt-4 rounded-tarjeta border border-line bg-raised p-4 sm:p-6" aria-label="Evolución de conversaciones">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 className="font-display text-seccion font-bold text-ink">El ritmo de tus conversaciones</h2>
            <p className="mt-1 text-sm text-muted">Nuevas y resueltas, día a día. Las líneas comparten la misma escala.</p></div>
          <Badge role="neutral">{fechaReporte(rango.from)} – {fechaReporte(rango.to)}</Badge>
        </div>
        {!movimiento ? <EstadoVacio compacto className="mt-4" titulo="Todavía no hay movimiento en este período"
          descripcion="Aquí verás cómo evolucionan las conversaciones y oportunidades cuando tu equipo empiece a atender. También puedes elegir un período más amplio arriba."
          accion={{ etiqueta: 'Abrir la bandeja', href: '/bandeja' }} /> : <>
          <GraficoSeries key={`${tenant}/${dias}`} titulo="Conversaciones nuevas y resueltas por día" etiquetas={etiquetas}
            series={[{ nombre: 'Conversaciones', valores: serie.map((x) => x.conversaciones), tono: 'action' },
              { nombre: 'Resueltas', valores: serie.map((x) => x.resueltas), tono: 'good' }]} />
          <details className="mt-4 text-sm text-body">
            <summary className="w-fit cursor-pointer text-action-text">Ver datos por día</summary>
            <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs">
              <caption className="sr-only">Conversaciones, resueltas y oportunidades del {fechaReporte(rango.from)} al {fechaReporte(rango.to)}</caption>
              <thead><tr>{['Día', 'Conversaciones', 'Resueltas', 'Oportunidades'].map((label) => <th className="p-2" key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{serie.map((x) => <tr className="border-t border-line" key={x.day}><th className="p-2 font-mono font-normal" scope="row">{fechaReporte(x.day)}</th>{[x.conversaciones, x.resueltas, x.oportunidades].map((valor, i) => <td className="p-2 font-mono" key={i}>{numero.format(valor)}</td>)}</tr>)}</tbody>
            </table></div>
          </details>
        </>}
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="pulso-panel rounded-tarjeta border border-line bg-raised p-5" aria-label="Resultados comerciales">
          <h2 className="font-display text-seccion font-bold text-ink">De oportunidad a resultado</h2>
          <p className="mt-1 text-sm text-muted" title={d.tasa_cierre}>Ganadas sobre las oportunidades cerradas del período.</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-5">
            <GraficoCierre ganadas={m.ganadas ?? 0} perdidas={m.perdidas ?? 0} tasa={datos.tasaCierre} />
            <dl className="min-w-0 flex-1 space-y-3 text-sm">
              <div className="flex justify-between gap-3"><dt>Ganadas</dt><dd className="font-mono font-bold">{numero.format(m.ganadas ?? 0)}</dd></div>
              <div className="flex justify-between gap-3"><dt>Perdidas</dt><dd className="font-mono">{numero.format(m.perdidas ?? 0)}</dd></div>
              <div className="border-t border-line pt-3"><dt className="text-muted">Valor ganado</dt><dd className="mt-1 break-words font-mono text-xl font-bold" title={d.valor_ganado_clp}>{fmtClp(m.valor_ganado_clp)}</dd></div>
            </dl>
          </div>
          <p className="mt-4 text-xs text-muted">Las resueltas y ganadas pueden haberse iniciado antes del rango. No representan un embudo de las conversaciones nuevas.</p>
        </section>
        <section className="pulso-panel rounded-tarjeta border border-line bg-raised p-5" aria-label="Oportunidades creadas">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-seccion font-bold text-ink">Oportunidades que llegan</h2><strong className="font-mono text-xl" title={d.oportunidades_creadas}>{numero.format(m.oportunidades_creadas)}</strong></div>
          <p className="mt-1 text-sm text-muted">Oportunidades creadas en cada día del período.</p>
          <GraficoSeries key={`${tenant}/${dias}`} titulo="Oportunidades creadas por día" etiquetas={etiquetas}
            series={[{ nombre: 'Oportunidades', valores: serie.map((x) => x.oportunidades), tono: 'warn' }]} />
        </section>
      </div>

      <h2 className="mt-7 font-display text-seccion font-bold text-ink">Recursos y actividad</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Cifra rotulo="Mensajes enviados" valor={numero.format(m.mensajes_enviados)} definicion={d.mensajes_enviados} />
        <Cifra rotulo="Uso de IA" valor={numero.format(m.ia_ejecuciones)} definicion={`${d.ia_ejecuciones} Costo estimado: USD ${m.ia_costo_usd.toFixed(3)}.`} />
        <Cifra rotulo="Costo Meta" valor={m.costo_meta_usd > 0 ? `USD ${m.costo_meta_usd.toFixed(2)}` : '—'} definicion={d.costo_meta_usd} />
        <Cifra rotulo="Citas" valor={m.citas_agendadas > 0 ? numero.format(m.citas_agendadas) : '—'} definicion={d.citas_agendadas} />
        <Cifra amplia rotulo="Pagos" valor={m.pagos_recibidos_clp > 0 ? fmtClp(m.pagos_recibidos_clp) : '—'} definicion={d.pagos_recibidos_clp} />
      </div>
      <div className="mt-6"><PreguntaALosNumeros key={tenant} /></div>
    </div>}
  </section>;
}
