'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, useSession } from '@iaxti/ui/react';
import { onboardingBusiness, onboardingCosts, type OnboardingBusiness, type OnboardingCosts } from '@iaxti/sdk';
import { avisoDe, fmtClp, type Aviso } from '../lib/api';

/** Consume los mismos costos del ciclo que facturación; no calcula tarifas. */
export function OnboardingCostos({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const [data, setData] = useState<{ business: OnboardingBusiness; costs: OnboardingCosts } | null>(null);
  const [error, setError] = useState<Aviso | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    if (!session) return;
    setData(null); setError(null);
    try {
      const connection = { apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant };
      const [business, costs] = await Promise.all([onboardingBusiness(connection, signal), onboardingCosts(connection, signal)]);
      if (!signal.aborted) setData({ business, costs });
    } catch (err) {
      if (!signal.aborted) setError(avisoDe(err));
    }
  }, [session, config.apiUrl, tenant]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);
  const cycle = data?.costs.cicloEnCurso;
  return <section aria-labelledby="onboarding-costos" className="pulso-panel rounded-tarjeta border border-line bg-raised p-5">
    <h2 id="onboarding-costos" className="font-display text-xl text-ink">Tu prueba y tus costos</h2>
    {error ? <><p role="alert" className="mt-2 text-body">{error.texto}</p>{error.rastro && <p className="dato mt-2 break-all text-xs text-muted">{error.rastro}</p>}<Button className="mt-3" variant="secundario" onClick={() => setRevision((value) => value + 1)}>Actualizar costos</Button></>
      : !data ? <p role="status" className="mt-2 text-muted">Cargando los costos del ciclo…</p>
        : <>
          <p className="mt-2 text-body">Plan {data.business.plan}.
            {data.business.state === 'trial' && <> Prueba gratis, sin tarjeta{data.business.trialEndsAt && <> hasta el <span className="dato">{new Date(data.business.trialEndsAt).toLocaleDateString('es-CL', { timeZone: 'America/Santiago' })}</span></>}.</>}
          </p>
          {cycle ? <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Meta · consumo registrado del ciclo</dt><dd className="dato text-ink">{fmtClp(cycle.metaUsd * cycle.usdClpRate)} · USD {cycle.metaUsd.toFixed(4)}</dd></div>
            <div><dt className="text-muted">IA · consumo registrado del ciclo</dt><dd className="dato text-ink">{cycle.ia ? <>{fmtClp(cycle.ia.clp)} · USD {cycle.ia.usd.toFixed(4)}</> : 'No disponible'}</dd></div>
          </dl> : <p className="mt-3 text-muted">Todavía no hay un ciclo de costos disponible. Puedes volver a revisarlo en Facturación.</p>}
          <p className="mt-3 text-xs text-muted">Estos son costos de consumo, no un cobro. Meta se muestra sin margen; la IA está sujeta a la cuota del plan.</p>
        </>}
    <Link className="mt-4 inline-block text-action-text underline underline-offset-4" href="/ajustes/facturacion">Ver facturación y consumo</Link>
  </section>;
}
