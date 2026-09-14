'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch, type ConversacionItem } from '../../lib/api';
import { ESTADOS } from '../bandeja/estado';

/** Historia unificada (#32): TODAS las conversaciones del contacto,
 *  resueltas y archivadas incluidas — nada se borra, todo se encuentra. */
export function HistoriaConversaciones({ contactId }: { contactId: string }) {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [items, setItems] = useState<ConversacionItem[] | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const res = await apiFetch<{ items: ConversacionItem[] }>(
        config, session, tenant, `/conversations?contactId=${contactId}`,
      );
      setItems(res.items);
    } catch {
      setItems([]);
    }
  }, [config, session, tenant, contactId]);
  useEffect(() => void cargar(), [cargar]);

  return (
    <section>
      <p className="rotulo">Conversaciones</p>
      {items === null ? (
        <div className="mt-2 flex flex-col gap-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Sin conversaciones todavía.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id}>
              <a
                href="/bandeja"
                className="flex items-center gap-3 rounded-campo border border-line bg-raised px-4 py-3 transition-colors hover:bg-rest"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{c.channel}</span>
                  <span className="dato block text-muted">
                    {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString('es-CL') : '—'}
                  </span>
                </span>
                <Badge role={ESTADOS[c.state].role}>{ESTADOS[c.state].label}</Badge>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
