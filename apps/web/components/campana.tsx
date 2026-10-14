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
  toast,
  useSession,
} from '@iaxti/ui/react';
import { usePieza } from './arranque';
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

  /**
   * La primera tanda sale del arranque; después se sondea (#761).
   *
   * Esta es la división que vale para todo lo que se refresca: el arranque
   * ahorra la llamada de ENTRADA, que es la que pelea con las otras veinte por
   * las seis conexiones que el navegador abre por host. El sondeo de cada minuto
   * no estorba a nadie y sigue por su ruta suelta, que es la que puede pedir
   * solo esto.
   */
  const delArranque = usePieza('avisos');
  useEffect(() => {
    if (!delArranque.puedeVerla || !delArranque.dato) return;
    const dato = delArranque.dato as { items: AvisoDto[]; unread: number };
    setItems(dato.items);
    setUnread(dato.unread);
  }, [delArranque.puedeVerla, delArranque.dato]);

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
    // Sin `cargar()` inmediato: eso lo trae el arranque. Si el arranque falló,
    // el primer sondeo llega en un minuto y la campana no suena hasta entonces
    // — que es mejor que pagar la llamada de entrada en cada carga por un caso
    // que no pasa.
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
            <span className="dato absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-boton bg-action px-1 text-rotulo font-bold text-white">
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
                // Por sonner y no por un aviso en el panel: esto vive en un
                // desplegable que se cierra, así que un mensaje dibujado acá
                // se iría con él (#588, punto 4).
                void apiFetch(config, session, tenant, '/notifications/read', {
                  method: 'POST',
                  body: JSON.stringify({}),
                })
                  .then(cargar)
                  .catch(() => toast.error('No pudimos marcar los avisos como leídos.'));
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
                    /**
                     * Este SÍ se traga el fallo, y con motivo.
                     *
                     * El clic también sigue el enlace: un milisegundo después
                     * esta pantalla no existe, así que no hay dónde mostrar un
                     * error ni nada que reintentar desde acá. Lo peor que pasa
                     * es que el aviso siga marcado como no leído, y eso se ve
                     * —el punto se queda— y se arregla volviendo a entrar.
                     *
                     * El `catch` vacío no es para esconderlo: es para que la
                     * promesa no quede rechazada sin dueño, que en el
                     * navegador es un error en la consola sin relación visible
                     * con lo que la persona hizo.
                     */
                    void apiFetch(config, session, tenant, '/notifications/read', {
                      method: 'POST',
                      body: JSON.stringify({ ids: [n.id] }),
                    }).catch(() => {});
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
