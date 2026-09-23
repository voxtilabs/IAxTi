'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { LlevarseLosDatos } from './llevarse-los-datos';
import { CancelarSuscripcion } from './cancelar-suscripcion';
import { apiFetch, fmtClp } from '../lib/api';

// Facturación (#67, SPEC §20): el plan, el próximo cobro y las facturas
// con los TRES costos separados — montos en mono, nada de totales mágicos.

interface FacturacionDto {
  subscription: { plan: string; status: string; nextChargeAt: string };
  invoices: Array<{
    id: string;
    periodStart: string;
    periodEnd: string;
    lines: Array<{ concepto: string; detalle: string; amountClp: number }>;
    totalClp: number;
    status: 'issued' | 'paid' | 'overdue' | 'void';
    dueAt: string;
  }>;
}

const ESTADO: Record<string, { label: string; role: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  issued: { label: 'Por pagar', role: 'warn' },
  paid: { label: 'Pagada', role: 'good' },
  overdue: { label: 'Vencida', role: 'bad' },
  void: { label: 'Anulada', role: 'neutral' },
  active: { label: 'Al día', role: 'good' },
  past_due: { label: 'Con deuda', role: 'bad' },
  cancelled: { label: 'Cancelada', role: 'neutral' },
};

export function Facturacion() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [datos, setDatos] = useState<FacturacionDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setDatos(await apiFetch<FacturacionDto>(config, session, tenant, '/billing'));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (aviso) {
    return (
      <AvisoResultado persistente>
        {aviso}
      </AvisoResultado>
    );
  }
  if (!datos) return <div className="max-w-xl"><Skeleton className="h-48" /></div>;

  const sub = datos.subscription;
  return (
    <div className="max-w-xl">
      <EncabezadoDePagina
        rotulo="FACTURACIÓN"
        titulo="Tu plan y tus facturas"
      />

      <div className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="rotulo">Plan {sub.plan}</span>
          <Badge role={ESTADO[sub.status]?.role ?? 'neutral'}>{ESTADO[sub.status]?.label ?? sub.status}</Badge>
        </div>
        <p className="mt-2 text-sm text-muted">
          Próximo cobro: <span className="dato text-body">{sub.nextChargeAt}</span>. La factura llega
          con los tres costos separados: plan, exceso de WhatsApp y ampliación de IA. La boleta se
          emite con estos mismos datos.
        </p>
      </div>

      {datos.invoices.length > 0 && (
        <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
          <span className="rotulo">Facturas</span>
          <ul className="mt-2 flex flex-col gap-3">
            {datos.invoices.map((f) => (
              <li key={f.id} className="rounded-campo border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="dato text-sm text-body">{f.periodStart} → {f.periodEnd}</span>
                  <Badge role={ESTADO[f.status].role}>{ESTADO[f.status].label}</Badge>
                </div>
                <ul className="mt-2 flex flex-col gap-1">
                  {f.lines.map((l, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="text-muted">{l.detalle}</span>
                      <span className="dato shrink-0 text-body">{fmtClp(l.amountClp)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2">
                  <span className="rotulo">Total</span>
                  <span className="dato font-bold text-ink">{fmtClp(f.totalClp)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <LlevarseLosDatos />
      {/* Cancelar va DESPUÉS de la exportación, y no porque sea menos
          importante: quien está por irse debería ver primero que sus datos
          son suyos. La ruta igual genera la exportación antes de cerrar. */}
      {sub.status !== 'cancelled' && <CancelarSuscripcion onCancelada={() => void cargar()} />}
    </div>
  );
}
