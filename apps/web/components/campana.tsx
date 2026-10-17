'use client';

import { Bell } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AvisoResultado, Badge, Button, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  EstadoVacio, Skeleton, toast, useSession,
} from '@iaxti/ui/react';
import { useArranque } from './arranque';
import { useSelectedTenant } from './tenant-switcher';
import { ApiError, apiFetch, avisoDe, type Aviso } from '../lib/api';
import { AvisoDeCarga } from './aviso-de-carga';
import type { Carga } from './use-carga';

export interface AvisoDto {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  groupCount: number;
  readAt: string | null;
  createdAt: string;
}
export interface AvisosDto { items: AvisoDto[]; unread: number }
type CargaDeAvisos = Carga<AvisosDto> | { estado: 'modulo-apagado' };

export function Campana() {
  const { session } = useSession();
  const tenant = useSelectedTenant();
  // Un cambio de negocio O de sesión descarta datos y peticiones anteriores.
  return session && tenant
    ? <CampanaDelNegocio key={`${tenant}|${session.access_token}`} tenant={tenant} />
    : null;
}

function CampanaDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const { arranque, error: errorDeArranque } = useArranque();
  const pieza = arranque?.avisos;
  const [carga, setCarga] = useState<CargaDeAvisos>({ estado: 'cargando' });
  const [ultimoDato, setUltimoDato] = useState<AvisosDto | null>(null);
  const [recargando, setRecargando] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const pedido = useRef(0);
  const pendiente = useRef<AbortController | null>(null);
  const vigente = useRef(true);

  useEffect(() => {
    vigente.current = true;
    return () => {
      vigente.current = false;
      pendiente.current?.abort();
    };
  }, []);

  const cargar = useCallback(async () => {
    if (!session) return false;
    const turno = ++pedido.current;
    pendiente.current?.abort();
    const controller = new AbortController();
    pendiente.current = controller;
    setRecargando(true);
    try {
      const dato = await apiFetch<AvisosDto>(config, session, tenant, '/notifications', { signal: controller.signal });
      if (!vigente.current || turno !== pedido.current || controller.signal.aborted) return false;
      setUltimoDato(dato);
      setCarga({ estado: 'ok', dato });
      return true;
    } catch (e) {
      if (!vigente.current || turno !== pedido.current || controller.signal.aborted) return false;
      if (e instanceof ApiError && (e.status === 403 || e.code === 'MODULE_DISABLED')) {
        // Si se revocó el acceso, tampoco se conserva la última lista privada.
        setUltimoDato(null);
        setAviso(null);
        setCarga({ estado: e.code === 'MODULE_DISABLED' ? 'modulo-apagado' : 'sin-permiso' });
      } else {
        // El fallo del refresco se ve SIN borrar los avisos ya recibidos.
        setCarga({ estado: 'falla', aviso: avisoDe(e) });
      }
      return false;
    } finally {
      if (vigente.current && turno === pedido.current) setRecargando(false);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    // El arranque evita duplicar la llamada inicial (#761). Si falló, la ruta
    // propia recupera esta pieza y conserva el error estructurado de la API.
    if (!pieza && errorDeArranque === null) return;
    if (!pieza || pieza.estado === 'falla') {
      void cargar();
      return;
    }
    pedido.current++;
    pendiente.current?.abort();
    setRecargando(false);
    if (pieza.estado === 'ok') {
      const dato = pieza.dato as AvisosDto;
      setUltimoDato(dato);
      setCarga({ estado: 'ok', dato });
    } else {
      setUltimoDato(null);
      setAviso(null);
      setCarga({ estado: pieza.estado });
    }
  }, [pieza, errorDeArranque, cargar]);

  const sinAcceso = carga.estado === 'sin-permiso' || carga.estado === 'modulo-apagado';
  useEffect(() => {
    if (sinAcceso) return;
    const timer = setInterval(() => void cargar(), 60_000);
    return () => clearInterval(timer);
  }, [cargar, sinAcceso]);

  const marcar = async (ids?: string[]): Promise<boolean> => {
    if (!session || marcando || sinAcceso) return false;
    setMarcando(true);
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, '/notifications/read', {
        method: 'POST', body: JSON.stringify(ids ? { ids } : {}),
      });
      if (!vigente.current) return false;
      const actualizado = await cargar();
      return actualizado && vigente.current;
    } catch (e) {
      if (!vigente.current) return false;
      if (e instanceof ApiError && e.status === 403) {
        pendiente.current?.abort();
        pedido.current++;
        setUltimoDato(null);
        setRecargando(false);
        setCarga({ estado: e.code === 'MODULE_DISABLED' ? 'modulo-apagado' : 'sin-permiso' });
        return false;
      }
      const fallo = avisoDe(e);
      setAviso(fallo);
      // Sigue siendo visible si el enlace del aviso cierra el desplegable.
      toast.error(fallo.texto, { description: fallo.rastro ?? undefined });
      return false;
    } finally {
      if (vigente.current) setMarcando(false);
    }
  };

  const dato = carga.estado === 'ok' ? carga.dato : ultimoDato;
  const unread = dato?.unread ?? 0;
  const items = dato?.items ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="fantasma" size="icono" aria-label={`Avisos${unread ? `, ${unread} sin leer` : ''}`} className="relative">
          <Bell className="size-5" aria-hidden />
          {unread > 0 && <span className="dato absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-boton bg-action px-1 text-rotulo font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]" onKeyDownCapture={(e) => {
        // Radix recorre sus items con flechas y bloquea Tab. Este panel también
        // contiene las acciones nativas de EstadoVacio/AvisoDeCarga: Tab debe
        // alcanzarlas sin duplicar esos componentes ni perder el foco del menú.
        if (e.key !== 'Tab') return;
        const controles = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'))
          .filter((el) => el.getAttribute('aria-disabled') !== 'true');
        if (!controles.length) return;
        e.preventDefault();
        e.stopPropagation();
        const actual = controles.indexOf(document.activeElement as HTMLElement);
        const siguiente = actual < 0 ? (e.shiftKey ? controles.length - 1 : 0)
          : (actual + (e.shiftKey ? -1 : 1) + controles.length) % controles.length;
        controles[siguiente].focus();
      }}>
        <div className="flex min-h-control items-center justify-between gap-2 px-3">
          <DropdownMenuLabel className="p-0">Avisos</DropdownMenuLabel>
          {unread > 0 && <DropdownMenuItem asChild disabled={marcando || recargando} onSelect={(e) => { e.preventDefault(); void marcar(); }} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"><Button variant="fantasma" size="chico" disabled={marcando || recargando}>{marcando ? 'Marcando…' : 'Marcar todo leído'}</Button></DropdownMenuItem>}
        </div>
        <DropdownMenuSeparator />
        {/* El panel conserva sus 320 px en carga, vacío y contenido: la lista
            desplaza por dentro. El e2e mide este mismo marco en ambos estados. */}
        <section aria-label="Lista de avisos" aria-busy={carga.estado === 'cargando' || recargando} className="h-80 overflow-y-auto">
          {carga.estado === 'cargando' && <div role="status" aria-label="Cargando avisos" className="flex flex-col gap-3 p-3">
            {[0, 1, 2].map((fila) => <div key={fila} className="flex flex-col gap-2"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-4 w-full" /></div>)}
          </div>}
          {carga.estado === 'modulo-apagado' && <p className="p-3 text-sm text-muted">Los avisos están desactivados en la plataforma.</p>}
          {carga.estado !== 'modulo-apagado' && <AvisoDeCarga carga={carga} onReintentar={() => void cargar()} sinPermiso="No tienes permiso para ver los avisos. Pide acceso a quien administra tu negocio." />}
          {aviso && <AvisoResultado tono="error" persistente>{aviso.texto}{aviso.rastro && <span className="dato mt-1 block text-rotulo">{aviso.rastro}</span>}</AvisoResultado>}
          {dato && items.length === 0 && <EstadoVacio compacto titulo="Nada nuevo por ahora" descripcion="Aquí aparecerán las menciones, tareas y novedades de tu negocio. Puedes elegir qué avisos recibir." accion={{ etiqueta: 'Configurar avisos', href: '/ajustes/notificaciones' }} />}
          {dato && items.length > 0 && <ul>
            {items.map((n) => <li key={n.id}>
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2"><a href={n.link ?? '#'} className="block min-h-control rounded-campo px-3 py-2 transition-colors hover:bg-rest" onClick={(e) => {
                if (n.readAt) return;
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
                  // La página actual permanece abierta y puede avisar del fallo.
                  // Conserva la apertura nativa en otra pestaña/ventana.
                  void marcar([n.id]);
                  return;
                }
                // Una navegación nativa desmontaba el panel antes de que un
                // POST fallido pudiera avisar. Esperamos el resultado; si falla
                // el enlace sigue aquí para reintentar y el rastro no se pierde.
                e.preventDefault();
                void marcar([n.id]).then((ok) => { if (ok) window.location.assign(n.link ?? '#'); });
              }}>
                <span className="flex items-center gap-2"><span className={`text-sm ${n.readAt ? 'text-muted' : 'font-medium text-ink'}`}>{n.title}</span>{n.groupCount > 1 && <Badge role="action">×{n.groupCount}</Badge>}</span>
                {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
              </a></DropdownMenuItem>
            </li>)}
          </ul>}
        </section>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
