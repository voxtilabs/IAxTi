'use client';

import { useEffect, useState } from 'react';
import {
  ModeToggle,
  RequireSession,
  SessionProvider,
  useSession,
  type PublicConfig,
} from '@iaxti/ui/react';

interface TenantRow {
  id: string;
  name: string;
  rubro: string | null;
  plan: string;
  state: string;
  createdAt: string;
}

// El color nunca es el único portador: la etiqueta lleva el texto del estado.
const ESTADO_ROL: Record<string, string> = {
  trial: 'bg-action-soft text-action-text border-action-soft-br',
  active: 'bg-good-soft text-good-text border-good-soft-br',
  past_due: 'bg-warn-soft text-warn-text border-warn-soft-br',
  read_only: 'bg-warn-soft text-warn-text border-warn-soft-br',
  suspended: 'bg-bad-soft text-bad-text border-bad-soft-br',
  deleted: 'bg-bad-soft text-bad-text border-bad-soft-br',
};

function CerrarSesion() {
  const { supabase } = useSession();
  return (
    <button
      type="button"
      className="text-sm text-muted"
      onClick={() => void supabase.auth.signOut().then(() => (window.location.href = '/login'))}
    >
      Cerrar sesión
    </button>
  );
}

function TablaTenants() {
  const { session, config } = useSession();
  const [tenants, setTenants] = useState<TenantRow[] | null>(null);
  const [sinAcceso, setSinAcceso] = useState(false);

  useEffect(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/platform/tenants`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(async (res) => {
      if (res.status === 403) return setSinAcceso(true);
      if (res.ok) setTenants(await res.json());
    });
  }, [session, config.apiUrl]);

  if (sinAcceso) {
    return (
      <p className="rounded-campo border border-warn-soft-br bg-warn-soft px-5 py-4 text-sm text-warn-text">
        <span className="font-medium">Tu cuenta no es de plataforma.</span> Pide acceso a quien
        opera IAxTi.
      </p>
    );
  }
  if (!tenants) return <p className="text-muted">Cargando tenants…</p>;

  return (
    <div className="overflow-x-auto rounded-tarjeta border border-line bg-raised">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-rest text-left">
            {['Negocio', 'Rubro', 'Plan', 'Estado', 'Creado'].map((h) => (
              <th key={h} className="rotulo px-4 py-3 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="px-4 py-4 font-medium text-ink">{t.name}</td>
              <td className="px-4 py-4 text-body">{t.rubro ?? '—'}</td>
              <td className="px-4 py-4 text-body">{t.plan}</td>
              <td className="px-4 py-4">
                <span className={`rounded-boton border px-3 py-1 text-xs font-medium ${ESTADO_ROL[t.state] ?? 'bg-rest text-muted border-line'}`}>
                  {t.state}
                </span>
              </td>
              <td className="dato px-4 py-4 text-right text-ink">
                {new Date(t.createdAt).toISOString().slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminShell({ config, marcaSvg }: { config: PublicConfig; marcaSvg: string }) {
  return (
    <SessionProvider config={config}>
      <RequireSession>
        <div className="min-h-screen bg-bg">
          <header className="border-b border-line bg-raised">
            <div className="mx-auto flex max-w-contenido flex-wrap items-center gap-4 px-4 py-3">
              <a href="/" className="marca" aria-label="VoxTi Labs, panel de IAxTi"
                 dangerouslySetInnerHTML={{ __html: marcaSvg }} />
              <span className="rotulo">SuperAdmin</span>
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <ModeToggle />
                <CerrarSesion />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-contenido px-4 py-8">
            <h2 className="mb-4 text-xl font-bold text-ink">Tenants</h2>
            <TablaTenants />
          </main>
        </div>
      </RequireSession>
    </SessionProvider>
  );
}
