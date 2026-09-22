'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, CalendarClock, Check, Phone, StickyNote, Users } from 'lucide-react';
import {
  AvisoResultado,
  Badge,
  Button,
  EncabezadoDePagina,
  EstadoVacio,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

/**
 * Lo que hay que hacer (#454).
 *
 * Las actividades se creaban desde la ficha y también las crea el
 * asistente —`crm.create_activity` es una de las dos herramientas que la
 * ADR-0017 le permite escribir—, el barrido las marcaba vencidas y
 * publicaba el aviso… y no existía ninguna pantalla que las listara. La
 * única puerta era abrir la ficha del contacto exacto.
 *
 * «¿Qué tengo que hacer hoy?» no tenía respuesta en el producto.
 */
interface ActividadDto {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  type: 'llamada' | 'reunion' | 'tarea' | 'nota';
  title: string;
  body: string | null;
  dueAt: string | null;
  doneAt: string | null;
  createdByKind: string | null;
}

const ICONO = {
  llamada: Phone,
  reunion: Users,
  tarea: Check,
  nota: StickyNote,
} as const;

const TIPO = { llamada: 'Llamada', reunion: 'Reunión', tarea: 'Tarea', nota: 'Nota' } as const;

function cuando(iso: string | null): { texto: string; vencida: boolean } {
  if (!iso) return { texto: 'sin fecha', vencida: false };
  const fecha = new Date(iso);
  const hoy = new Date();
  const dias = Math.round((fecha.getTime() - hoy.getTime()) / 86_400_000);
  if (fecha < hoy) return { texto: dias === 0 ? 'vencida hoy' : `vencida hace ${Math.abs(dias)} d`, vencida: true };
  if (dias === 0) return { texto: 'hoy', vencida: false };
  if (dias === 1) return { texto: 'mañana', vencida: false };
  return { texto: fecha.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }), vencida: false };
}

export function Pendientes() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [ambito, setAmbito] = useState<'mias' | 'equipo'>('mias');
  const [items, setItems] = useState<ActividadDto[] | null>(null);
  const [marcando, setMarcando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setItems(
        await apiFetch<ActividadDto[]>(
          config,
          session,
          tenant,
          `/contacts/activities${ambito === 'equipo' ? '?todas=true' : ''}`,
        ),
      );
    } catch (e) {
      setAviso((e as Error).message);
    }
  }, [config, session, tenant, ambito]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const marcarHecha = async (id: string) => {
    if (!session) return;
    setAviso(null);
    setMarcando(id);
    try {
      await apiFetch(config, session, tenant, `/contacts/activities/${id}/done`, { method: 'POST' });
      // Se saca de la lista en vez de recargar entera: lo que se acaba de
      // hacer desaparece, y lo demás no se mueve debajo del cursor.
      setItems((previos) => (previos ?? []).filter((a) => a.id !== id));
    } catch (e) {
      setAviso((e as Error).message);
    } finally {
      setMarcando(null);
    }
  };

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <EncabezadoDePagina rotulo="PENDIENTES" titulo="Qué hay que hacer" />
        <Tabs value={ambito} onValueChange={(v) => setAmbito(v as 'mias' | 'equipo')}>
          <TabsList aria-label="De quién">
            <TabsTrigger value="mias">Mías</TabsTrigger>
            <TabsTrigger value="equipo">Del equipo</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <p className="mt-2 text-sm text-muted">
        Lo vencido primero. Incluye lo que dejó anotado el asistente.
      </p>

      {aviso && <AvisoResultado tono="error" persistente>{aviso}</AvisoResultado>}

      {items === null ? (
        <div className="mt-5 flex flex-col gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : items.length === 0 ? (
        <EstadoVacio
          className="mt-5"
          titulo="No tienes nada pendiente"
          descripcion={
            'Las tareas nacen en la ficha de un contacto, o las deja anotadas el asistente cuando ' +
            'algo queda por hacer después de una conversación.'
          }
          accion={{ etiqueta: 'Ir a contactos', href: '/contactos' }}
        />
      ) : (
        <ul className="mt-5 flex flex-col gap-2">
          {items.map((a) => {
            const Icono = ICONO[a.type];
            const { texto, vencida } = cuando(a.dueAt);
            return (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3"
              >
                <Icono aria-hidden className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{a.title}</span>
                    {/* Lo que anotó el asistente se revisa distinto de lo
                        que anotó uno mismo (#454). */}
                    {a.createdByKind === 'agent' && (
                      <span className="flex items-center gap-1 text-micro text-muted">
                        <Bot aria-hidden className="size-3" /> del asistente
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-muted">
                    {TIPO[a.type]} ·{' '}
                    <a className="text-action-text" href={`/contactos/${a.contactId}`}>
                      {a.contactName ?? a.contactPhone ?? 'un contacto'}
                    </a>
                    {a.body ? ` · ${a.body}` : ''}
                  </p>
                </div>
                <span className="flex items-center gap-1">
                  <CalendarClock aria-hidden className="size-3.5 text-faint" />
                  {vencida ? (
                    <Badge role="warn">{texto}</Badge>
                  ) : (
                    <span className="text-sm text-body">{texto}</span>
                  )}
                </span>
                <Button
                  variant="secundario"
                  size="chico"
                  disabled={marcando === a.id}
                  onClick={() => void marcarHecha(a.id)}
                >
                  {marcando === a.id ? '…' : 'Hecha'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
