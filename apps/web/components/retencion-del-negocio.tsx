'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive } from 'lucide-react';
import { AvisoResultado, Button, Input, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

/**
 * Cuánto tiempo guarda el negocio sus conversaciones (#480).
 *
 * `PUT /settings/retencion` existe desde #77 y no la llamaba nadie: la
 * bandeja mostraba desde cuándo NO hay historial y el negocio no podía
 * decidir nada. Acortar la retención es de las pocas decisiones que
 * BORRAN datos, y la ley de datos personales la supone posible.
 *
 * Nunca se puede alargar más que el plan: eso lo decide el servidor, que
 * es el único que sabe qué plan tiene este negocio hoy.
 */
interface RetencionDto {
  months: number | null;
  cutoff: string | null;
  deferredUntil: string | null;
}

interface GuardadoDto {
  saved: boolean;
  purgeNotice: { count: number; firstPurgeAt: string } | null;
}

export function RetencionDelNegocio() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [datos, setDatos] = useState<RetencionDto | null>(null);
  const [valor, setValor] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [purga, setPurga] = useState<GuardadoDto['purgeNotice']>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const r = await apiFetch<RetencionDto>(config, session, tenant, '/settings/retencion');
      setDatos(r);
      setValor(r.months === null ? '' : String(r.months));
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      const r = await apiFetch<GuardadoDto>(config, session, tenant, '/settings/retencion', {
        method: 'PUT',
        body: JSON.stringify({ months: valor.trim() === '' ? null : Number(valor) }),
      });
      // Cuántas conversaciones se van a borrar y CUÁNDO: la purga se
      // difiere 30 días justamente para que se pueda deshacer.
      setPurga(r.purgeNotice);
      setAviso(null);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  if (!tenant || !datos) return null;

  return (
    <section className="mt-10 border-t border-line pt-8">
      <p className="flex items-center gap-2">
        <Archive aria-hidden className="size-4 text-muted" />
        <h2 className="text-base font-bold text-ink">Cuánto se guardan las conversaciones</h2>
      </p>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Tu plan guarda {datos.months === null ? 'sin límite' : `${datos.months} meses`}. Puedes
        acortarlo si prefieres guardar menos — nunca alargarlo por encima del plan.
        {datos.cutoff && (
          <> Hoy el corte está en <span className="dato">{datos.cutoff}</span>.</>
        )}
      </p>

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      <form onSubmit={guardar} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Guardar por
          <span className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              className="dato w-24"
              placeholder="lo del plan"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
            />
            <span className="text-body">meses</span>
          </span>
          <span className="text-xs text-muted">
            En blanco vuelve a lo que da el plan.
          </span>
        </label>
        <Button type="submit" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>

      {purga && (
        // Se dice ANTES de que pase y con fecha: la purga se difiere 30
        // días a propósito, para que haya tiempo de arrepentirse.
        <p className="mt-3 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          Con ese plazo, {purga.count}{' '}
          {purga.count === 1 ? 'conversación se eliminará' : 'conversaciones se eliminarán'} a partir
          del <span className="dato">{purga.firstPurgeAt}</span>. Hasta entonces puedes volver a
          alargarlo y no se borra nada.
        </p>
      )}
      {purga === null && datos.deferredUntil && (
        <p className="mt-3 text-sm text-muted">
          Hay una purga pendiente para el <span className="dato">{datos.deferredUntil}</span>.
        </p>
      )}
    </section>
  );
}
