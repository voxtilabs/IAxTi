'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';

interface Membership {
  tenantId: string;
  tenantName: string;
  roleName: string;
}

const STORAGE_KEY = 'iaxti-tenant';

export function selectedTenant(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Reactualiza las pantallas que dependen del negocio, también en esta pestaña. */
export function useSelectedTenant(): string | null {
  const [tenant, setTenant] = useState<string | null>(null);
  useEffect(() => {
    const actualizar = () => setTenant(selectedTenant());
    actualizar();
    window.addEventListener('storage', actualizar);
    window.addEventListener('iaxti-tenant-changed', actualizar);
    return () => {
      window.removeEventListener('storage', actualizar);
      window.removeEventListener('iaxti-tenant-changed', actualizar);
    };
  }, []);
  return tenant;
}

/** Selector de negocio: GET /v1/me con el Bearer de la sesión (SPEC §9). */
export function TenantSwitcher() {
  const { session, config } = useSession();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selected, setSelected] = useState<string>('');

  useEffect(() => {
    if (!session) return;
    void fetch(`${config.apiUrl}/v1/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : { tenants: [] }))
      .then((me: { tenants: Membership[] }) => {
        setMemberships(me.tenants);
        const guardado = selectedTenant();
        const inicial =
          me.tenants.find((t) => t.tenantId === guardado)?.tenantId ?? me.tenants[0]?.tenantId ?? '';
        setSelected(inicial);
        if (inicial) {
          localStorage.setItem(STORAGE_KEY, inicial);
          window.dispatchEvent(new Event('iaxti-tenant-changed'));
        }
      });
  }, [session, config.apiUrl]);

  if (memberships.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      Negocio
      <select
        className="h-control rounded-campo border border-line-strong bg-field px-4 text-ink"
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          localStorage.setItem(STORAGE_KEY, e.target.value);
          window.dispatchEvent(new Event('iaxti-tenant-changed'));
        }}
      >
        {memberships.map((m) => (
          <option key={m.tenantId} value={m.tenantId}>
            {m.tenantName} · {m.roleName}
          </option>
        ))}
      </select>
    </label>
  );
}
