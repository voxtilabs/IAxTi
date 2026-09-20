'use client';

import { useCallback, useEffect, useState } from 'react';
import { Avatar, Badge, Button, EstadoVacio, Input, Skeleton, useSession } from '@iaxti/ui/react';
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
    <div className="max-w-2xl">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="font-display text-xl font-bold text-ink">Contactos</h1>
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
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-2 text-sm text-warn-text">
          {aviso}
        </p>
      )}
      {items === null ? (
        <div className="mt-4 flex flex-col gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : items.length === 0 ? (
        <EstadoVacio className="mt-6"
          titulo={q.trim() ? `Nada con “${q.trim()}”` : 'Aquí empieza tu cartera de contactos'}
          descripcion={q.trim() ? 'Prueba con el teléfono o con parte del nombre.' : 'Cada persona que escriba aparece aquí con su historia. Si ya tienes una planilla, impórtala para empezar.'}
          accion={q.trim() ? { etiqueta: 'Limpiar búsqueda', onClick: () => setQ('') } : { etiqueta: 'Importar contactos', href: '/contactos/importar' }}
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <a
                href={`/contactos/${c.id}`}
                className="flex items-center gap-3 rounded-campo border border-line bg-raised px-4 py-3 transition-colors hover:bg-rest"
              >
                <Avatar nombre={c.name} fallback={c.phone} />
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
