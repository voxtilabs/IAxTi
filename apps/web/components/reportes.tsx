'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, EstadoVacio, Skeleton, Tabs, TabsList, TabsTrigger, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { PreguntaALosNumeros } from './pregunta-a-los-numeros';
import { apiFetch, fmtClp } from '../lib/api';

// Reportes (#66, SPEC §19): cómo va el negocio sin configurar nada.
// Cada número muestra su DEFINICIÓN al pasar el cursor — nada inventado.

interface DashboardDto {
  metrics: Record<string, number>;
  primeraRespuesta: { medianaSeg: number | null; p90Seg: number | null; muestras: number };
  sinResponderAhora: number;
  tasaCierre: number | null;
  porDia: Array<{ day: string; conversaciones: number; resueltas: number; oportunidades: number }>;
  definiciones: Record<string, string>;
}

const RANGOS = [
  { dias: 7, label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
];

function fmtSeg(seg: number | null): string {
  if (seg === null) return '—';
  if (seg < 60) return `${seg} s`;
  if (seg < 3600) return `${Math.round(seg / 60)} min`;
  return `${(seg / 3600).toFixed(1)} h`;
}

function Cifra({
  rotulo, valor, definicion, alerta,
}: { rotulo: string; valor: string; definicion: string; alerta?: boolean }) {
  return (
    <div
      className="pulso-panel rounded-tarjeta border border-line bg-raised p-4"
      title={definicion}
    >
      <p className="rotulo">{rotulo}</p>
      <p className={`dato mt-1 text-2xl font-bold ${alerta ? 'text-warn-text' : 'text-ink'}`}>{valor}</p>
    </div>
  );
}

export function Reportes() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [dias, setDias] = useState(30);
  const [datos, setDatos] = useState<DashboardDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const hasta = new Date().toISOString().slice(0, 10);
      const desde = new Date(Date.now() - (dias - 1) * 86_400_000).toISOString().slice(0, 10);
      setDatos(
        await apiFetch<DashboardDto>(config, session, tenant, `/analytics/dashboard?from=${desde}&to=${hasta}`),
      );
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant, dias]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (aviso) {
    return (
      <AvisoResultado persistente>
        {aviso}
      </AvisoResultado>
    );
  }
  if (!datos) return <div className="max-w-3xl"><Skeleton className="h-64" /></div>;

  const d = datos.definiciones;
  const m = datos.metrics;
  const maxDia = Math.max(1, ...datos.porDia.map((x) => x.conversaciones));

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <EncabezadoDePagina
            rotulo="REPORTES"
            titulo="Cómo va el negocio"
          />
        </div>
        <Tabs value={String(dias)} onValueChange={(v) => setDias(Number(v))}>
          <TabsList>
            {RANGOS.map((r) => (
              <TabsTrigger key={r.dias} value={String(r.dias)}>{r.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <p className="mt-1 text-sm text-muted">
        Pasa el cursor sobre cualquier número para ver exactamente qué mide.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra rotulo="Conversaciones" valor={String(m.conversaciones_nuevas)} definicion={d.conversaciones_nuevas} />
        <Cifra rotulo="Sin responder AHORA" valor={String(datos.sinResponderAhora)} definicion={d.sin_responder_ahora} alerta={datos.sinResponderAhora > 0} />
        <Cifra rotulo="Resueltas" valor={String(m.resueltas)} definicion={d.resueltas} />
        <Cifra
          rotulo="1ª respuesta (mediana)"
          valor={fmtSeg(datos.primeraRespuesta.medianaSeg)}
          definicion={`${d.primera_respuesta} (${datos.primeraRespuesta.muestras} conversaciones medidas; p90 ${fmtSeg(datos.primeraRespuesta.p90Seg)})`}
        />
        <Cifra rotulo="Oportunidades" valor={String(m.oportunidades_creadas)} definicion={d.oportunidades_creadas} />
        <Cifra
          rotulo="Tasa de cierre"
          valor={datos.tasaCierre === null ? '—' : `${Math.round(datos.tasaCierre * 100)} %`}
          definicion={d.tasa_cierre}
        />
        <Cifra rotulo="Valor ganado" valor={fmtClp(m.valor_ganado_clp)} definicion={d.valor_ganado_clp} />
        <Cifra rotulo="Uso de IA" valor={String(m.ia_ejecuciones)} definicion={`${d.ia_ejecuciones} Costo estimado: USD ${m.ia_costo_usd.toFixed(3)}.`} />
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
        <div className="flex items-baseline justify-between">
          <span className="rotulo" title={d.conversaciones_nuevas}>Conversaciones por día</span>
          <Badge role="neutral">últimos {dias} días</Badge>
        </div>
        {datos.porDia.length === 0 ? (
          <EstadoVacio compacto className="mt-3" titulo="Todavía no hay movimiento en este período"
            descripcion="Aquí verás cómo evolucionan las conversaciones y oportunidades cuando tu equipo empiece a atender. También puedes elegir un período más amplio arriba."
            accion={{ etiqueta: 'Abrir la bandeja', href: '/bandeja' }} />
        ) : (
          <div className="mt-3 flex h-32 items-end gap-[2px]" role="img" aria-label="Conversaciones nuevas por día">
            {datos.porDia.map((x) => (
              <div
                key={x.day}
                className="flex-1 rounded-t-boton bg-action"
                style={{ height: `${Math.max(4, (x.conversaciones / maxDia) * 100)}%` }}
                title={`${x.day}: ${x.conversaciones} conversaciones, ${x.resueltas} resueltas, ${x.oportunidades} oportunidades`}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Cifra rotulo="Mensajes enviados" valor={String(m.mensajes_enviados)} definicion={d.mensajes_enviados} />
        <Cifra rotulo="Costo Meta" valor={m.costo_meta_usd > 0 ? `USD ${m.costo_meta_usd.toFixed(2)}` : '—'} definicion={d.costo_meta_usd} />
        <Cifra rotulo="Citas" valor={m.citas_agendadas > 0 ? String(m.citas_agendadas) : '—'} definicion={d.citas_agendadas} />
        <Cifra rotulo="Pagos" valor={m.pagos_recibidos_clp > 0 ? fmtClp(m.pagos_recibidos_clp) : '—'} definicion={d.pagos_recibidos_clp} />
      </div>

      {/* Va al final, DESPUÉS de los números: la pregunta nace mirándolos
          (#410), y así la respuesta queda al lado de lo que explica. */}
      <div className="mt-6">
        <PreguntaALosNumeros />
      </div>
    </div>
  );
}
