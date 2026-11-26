'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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

/**
 * Los negocios de la sesión, y uno elegido SIEMPRE (#1398).
 *
 * Esto vivía dentro del selector de la barra lateral. En el celular la barra
 * no se monta hasta que se abre el menú, así que quien entraba directo a una
 * pantalla que no fuera el inicio se quedaba sin negocio elegido: «Tu
 * asistente» no enviaba nada al apretar «Pedir», sin un error a la vista. Va
 * en el marco de la app, por encima de la barra, para que corra en cualquier
 * pantalla y cualquier ancho; el selector solo lo muestra.
 */
const Negocios = createContext<Membership[]>([]);

export function ProveedorDeNegocios({ children }: { children: ReactNode }) {
  const { session, config } = useSession();
  const [memberships, setMemberships] = useState<Membership[]>([]);
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
        // Solo se avisa si cambió: avisar siempre haría recargar cada pantalla
        // que escucha el cambio de negocio, sin que nada haya cambiado.
        if ((inicial || null) !== guardado) selectTenant(inicial || null);
      }).catch(() => {
        // El alta tiene su estado de error. Un fallo no prueba que esté vacío
        // ni debe borrar la selección que todavía no se pudo comprobar.
      });
    return () => controller.abort();
  }, [session, config.apiUrl, revision]);

  return <Negocios.Provider value={memberships}>{children}</Negocios.Provider>;
}

/** Selector de negocio: muestra lo que cargó `ProveedorDeNegocios` (SPEC §9). */
export function TenantSwitcher() {
  const memberships = useContext(Negocios);
  const selected = useSelectedTenant() ?? '';

  if (memberships.length === 0) return null;

  return (
    // Sin el rótulo visible «Negocio» (#1108): el disparador ya lleva
    // `aria-label="Negocio"`, así que el nombre accesible no cambia, y lo que
    // muestra —«E2E Bandeja · SUPERVISORA» con su flecha— se explica solo.
    // Costaba 24 px en una barra a la que le faltaban 162.
    <div className="flex flex-col">
      <Select
        value={selected}
        onValueChange={(valor) => selectTenant(valor)}
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
