'use client';

import { Bell } from 'lucide-react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// La campana (#55): no-leídos visibles desde cualquier pantalla.

interface AvisoDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  groupCount: number;
  readAt: string | null;
  createdAt: string;
}

export function Campana() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [items, setItems] = useState<AvisoDto[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const res = await apiFetch<{ items: AvisoDto[]; unread: number }>(
        config, session, tenant, '/notifications',
      );
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      /* módulo apagado o sin permiso: la campana simplemente no suena */
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
    const timer = setInterval(() => void cargar(), 60_000);
    return () => clearInterval(timer);
  }, [cargar]);

  if (!tenant) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="fantasma" size="icono" aria-label={`Avisos${unread ? `, ${unread} sin leer` : ''}`} className="relative">
          <Bell className="size-5" aria-hidden />
          {unread > 0 && (
            <span className="dato absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-boton bg-action px-1 text-[11px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-3 py-1.5">
          <DropdownMenuLabel className="p-0">Avisos</DropdownMenuLabel>
          {unread > 0 && (
            <button
              type="button"
              className="text-xs text-action-text"
              onClick={() => {
                if (!session || !tenant) return;
                void apiFetch(config, session, tenant, '/notifications/read', {
                  method: 'POST',
                  body: JSON.stringify({}),
                }).then(cargar);
              }}
            >
              Marcar todo leído
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">Nada nuevo por ahora.</p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {items.map((n) => (
              <li key={n.id}>
                <a
                  href={n.link ?? '#'}
                  className="block rounded-campo px-3 py-2 transition-colors hover:bg-rest"
                  onClick={() => {
                    if (!session || !tenant || n.readAt) return;
                    void apiFetch(config, session, tenant, '/notifications/read', {
                      method: 'POST',
                      body: JSON.stringify({ ids: [n.id] }),
                    });
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span className={`text-sm ${n.readAt ? 'text-muted' : 'font-medium text-ink'}`}>
                      {n.title}
                    </span>
                    {n.groupCount > 1 && <Badge role="action">×{n.groupCount}</Badge>}
                  </span>
                  {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
