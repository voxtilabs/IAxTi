'use client';

import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useSession } from '@iaxti/ui/react';

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
    <label className="flex flex-col gap-1 text-sm text-muted">
      Negocio
      <Select
        value={selected}
        onValueChange={(valor) => {
          setSelected(valor);
          localStorage.setItem(STORAGE_KEY, valor);
          window.dispatchEvent(new Event('iaxti-tenant-changed'));
        }}
      >
        <SelectTrigger className="h-control w-full bg-field" aria-label="Negocio">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {memberships.map((m) => (
            <SelectItem key={m.tenantId} value={m.tenantId}>
              {m.tenantName} · {m.roleName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
