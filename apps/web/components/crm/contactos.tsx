'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

interface ContactoItem {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  origin: string;
  optedOutAt: string | null;
}

/** /contactos (#34): búsqueda, cursor y la puerta a la importación. */
export function Contactos() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ContactoItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(
    async (siguiente?: string) => {
      if (!session || !tenant) return;
      try {
        const query = new URLSearchParams({ limit: '25' });
        if (q.trim()) query.set('q', q.trim());
        if (siguiente) query.set('cursor', siguiente);
        const res = await apiFetch<{ items: ContactoItem[]; nextCursor: string | null }>(
          config, session, tenant, `/contacts?${query}`,
        );
        setItems((prev) => (siguiente ? [...(prev ?? []), ...res.items] : res.items));
        setCursor(res.nextCursor);
      } catch (err) {
        setAviso((err as Error).message);
      }
    },
    [config, session, tenant, q],
  );
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  return (
    <div className="max-w-2xl" data-densidad="densa">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="font-display text-titulo font-bold text-ink">Contactos</h1>
        <a
          href="/contactos/importar"
          className="ml-auto inline-flex h-9 items-center rounded-boton border border-line-strong px-4 text-sm font-medium text-ink transition-colors hover:bg-rest"
        >
          Importar CSV
        </a>
      </div>
      <Input
        type="search"
        aria-label="Buscar contactos"
        placeholder="Buscar por nombre o teléfono…"
        className="mt-4"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
      {items === null ? (
        <div className="mt-4 flex flex-col gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : items.length === 0 ? (
        <div className="mt-6 rounded-tarjeta border border-line bg-raised p-8">
          <h2 className="text-seccion font-bold text-ink">Todavía no hay contactos</h2>
          <p className="mt-2 text-body">
            Cada persona que escriba al negocio aparece aquí sola. ¿Ya tienes una planilla?
            Impórtala y parte con tu cartera al día.
          </p>
        </div>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <a
                href={`/contactos/${c.id}`}
                className="flex min-h-control items-center gap-fila-gap rounded-campo border border-line bg-raised px-fila-x py-fila-y text-dato transition-colors hover:bg-rest"
              >
                <Avatar size="chico" nombre={c.name} fallback={c.phone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{c.name ?? 'Sin nombre aún'}</span>
                  <span className="dato block text-muted">{c.phone}</span>
                </span>
                {c.optedOutAt && <Badge role="bad">No contactar</Badge>}
                <Badge role="neutral">{c.origin}</Badge>
              </a>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button variant="secundario" size="chico" className="mt-4" onClick={() => void cargar(cursor)}>
          Cargar más
        </Button>
      )}
    </div>
  );
}
