'use client';

import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useSession } from '@iaxti/ui/react';
import { myBusinesses } from '@iaxti/sdk';

interface Membership {
  tenantId: string;
  tenantName: string;
  roleName: string;
}

const STORAGE_KEY = 'iaxti-tenant';

export function selectTenant(tenantId: string | null) {
  if (tenantId) localStorage.setItem(STORAGE_KEY, tenantId);
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('iaxti-tenant-changed'));
}

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
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('iaxti-memberships-changed', refresh);
    return () => window.removeEventListener('iaxti-memberships-changed', refresh);
  }, []);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    void myBusinesses({ apiUrl: config.apiUrl, token: session.access_token }, controller.signal)
      .then((me) => {
        if (controller.signal.aborted) return;
        setMemberships(me.tenants);
        const guardado = selectedTenant();
        const inicial =
          me.tenants.find((t) => t.tenantId === guardado)?.tenantId ?? me.tenants[0]?.tenantId ?? '';
        setSelected(inicial);
        selectTenant(inicial || null);
      }).catch(() => {
        // El alta tiene su estado de error. Un fallo no prueba que esté vacío
        // ni debe borrar la selección que todavía no se pudo comprobar.
      });
    return () => controller.abort();
  }, [session, config.apiUrl, revision]);

  if (memberships.length === 0) return null;

  return (
    // Sin el rótulo visible «Negocio» (#1108): el disparador ya lleva
    // `aria-label="Negocio"`, así que el nombre accesible no cambia, y lo que
    // muestra —«E2E Bandeja · SUPERVISORA» con su flecha— se explica solo.
    // Costaba 24 px en una barra a la que le faltaban 162.
    <div className="flex flex-col">
      <Select
        value={selected}
        onValueChange={(valor) => {
          setSelected(valor);
          selectTenant(valor);
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
    </div>
  );
}
