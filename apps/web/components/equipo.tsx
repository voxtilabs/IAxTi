'use client';

import { AvisoResultado, EncabezadoDePagina, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El equipo (#28, SPEC §22): quién entra al negocio y con qué rol.
//
// La API estaba completa —listar, invitar, cancelar, quitar acceso— y no
// había pantalla. Y "Invita a tu equipo" es un PASO DEL ONBOARDING: sin
// forma de hacerlo desde la app, ese paso solo se podía completar llamando
// a la API a mano.

interface MiembroDto {
  userId: string;
  nombre: string | null;
  email: string | null;
  rol: string;
  desde: string;
}

interface InvitacionDto {
  id: string;
  email: string | null;
  phone: string | null;
  rol: string;
  expiraEl: string;
  vencida: boolean;
}

interface RolDisponible {
  id: string;
  name: string;
}

function cuando(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function Equipo() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [datos, setDatos] = useState<{ miembros: MiembroDto[]; invitaciones: InvitacionDto[] } | null>(null);
  const [roles, setRoles] = useState<RolDisponible[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', rol: 'USER' });
  const [enviando, setEnviando] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    const [equipo, disponibles] = await Promise.allSettled([
      apiFetch<{ miembros: MiembroDto[]; invitaciones: InvitacionDto[] }>(config, session, tenant, '/equipo'),
      apiFetch<RolDisponible[]>(config, session, tenant, '/roles'),
    ]);
    if (equipo.status === 'fulfilled') {
      setDatos(equipo.value);
      setError(null);
    } else {
      setError((equipo.reason as Error).message);
      setDatos({ miembros: [], invitaciones: [] });
    }
    // Sin el catálogo siguen disponibles los roles base, igual que antes.
    setRoles(
      disponibles.status === 'fulfilled'
        ? disponibles.value
        : // Sin el catálogo siguen los roles base por NOMBRE: alcanza para
          // invitar, no para cambiarle el rol a alguien —eso pide el id— y
          // por eso el selector de la fila se apaga cuando esto pasa.
          [
            { id: '', name: 'ADMIN' },
            { id: '', name: 'SUPERVISOR' },
            { id: '', name: 'USER' },
          ],
    );
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Le cambia el rol a alguien del equipo. Lo que NO se comprueba acá es
   * quedarse sin administradores: eso lo decide el servidor en la misma
   * transacción, porque el equipo puede cambiar entre que esta pantalla
   * cargó y el clic.
   */
  async function cambiarRol(m: MiembroDto, roleId: string) {
    if (!session || !tenant || !roleId || cambiando) return;
    const rol = roles.find((r) => r.id === roleId);
    if (!rol || rol.name === m.rol) return;
    setCambiando(m.userId);
    setOk(null);
    try {
      await apiFetch(config, session, tenant, '/roles/assign', {
        method: 'POST',
        body: JSON.stringify({ userId: m.userId, roleId }),
      });
      setError(null);
      setOk(`${m.nombre ?? m.email ?? 'Esa persona'} ahora es ${rol.name}.`);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCambiando(null);
    }
  }

  async function invitar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || enviando) return;
    setEnviando(true);
    try {
      await apiFetch(config, session, tenant, '/equipo/invitaciones', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setOk(`Invitación enviada a ${form.email}.`);
      setError(null);
      setForm({ email: '', rol: form.rol });
      await cargar();
    } catch (err) {
      setError((err as Error).message);
      setOk(null);
    } finally {
      setEnviando(false);
    }
  }

  async function cancelar(inv: InvitacionDto) {
    if (!session || !tenant || quitando) return;
    setQuitando(inv.id);
    try {
      await apiFetch(config, session, tenant, `/equipo/invitaciones/${inv.id}`, { method: 'DELETE' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQuitando(null);
    }
  }

  async function quitar(m: MiembroDto) {
    if (!session || !tenant || quitando) return;
    setQuitando(m.userId);
    try {
      await apiFetch(config, session, tenant, `/equipo/miembros/${m.userId}`, { method: 'DELETE' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQuitando(null);
    }
  }

  if (datos === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <EncabezadoDePagina
        titulo="Tu equipo"
        apoyo="Quién entra al negocio y qué puede hacer. Cada persona atiende con su propia cuenta: así se sabe quién respondió qué."
      />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}
      {ok && (
        <AvisoResultado tono="success">
          {ok}
          {/* El detalle del enlace es de la invitación, no de un cambio de
              rol: pegado siempre, decía una cosa falsa la mitad de las
              veces. */}
          {ok.startsWith('Invitación') &&
            ' Le llega un enlace para entrar; mientras no lo use, la invitación aparece abajo.'}
        </AvisoResultado>
      )}

      <form onSubmit={invitar} className="flex flex-col gap-4 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">Invitar a alguien</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm font-medium text-ink">
            Su correo
            <Input
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="vendedor@tunegocio.cl"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Con qué rol
            <Select value={form.rol} onValueChange={(valor) => setForm({ ...form, rol: valor })}>
              <SelectTrigger className="h-control bg-field text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.name} value={r.name}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button type="submit" disabled={enviando}>
            {enviando ? 'Enviando…' : 'Invitar'}
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-ink">Con acceso ({datos.miembros.length})</h2>
        <ul className="flex flex-col gap-2">
          {datos.miembros.map((m) => (
            <li
              key={m.userId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {m.nombre ?? m.email ?? 'Sin nombre'}
                </span>
                {m.email && m.nombre && <span className="block truncate text-xs text-muted">{m.email}</span>}
              </span>
              {/* Cambiar el rol (#460). `POST /roles/assign` existía desde
                  #73 y no la llamaba nadie: el rol con el que alguien entró
                  era el rol que tenía para siempre, y la única salida era
                  quitarle el acceso y volver a invitarlo. */}
              {roles.some((r) => r.id) ? (
                <Select
                  value={roles.find((r) => r.name === m.rol)?.id ?? ''}
                  onValueChange={(id) => void cambiarRol(m, id)}
                  disabled={cambiando === m.userId}
                >
                  <SelectTrigger className="h-9 w-40 bg-field text-sm" aria-label={`Rol de ${m.nombre ?? m.email ?? 'esta persona'}`}>
                    <SelectValue placeholder={m.rol} />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge role="neutral">{m.rol}</Badge>
              )}
              <span className="text-xs text-muted">desde el {cuando(m.desde)}</span>
              <Button
                variant="fantasma"
                size="chico"
                disabled={quitando === m.userId}
                onClick={() => void quitar(m)}
              >
                Quitar acceso
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {datos.invitaciones.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-base font-bold text-ink">Invitaciones sin usar</h2>
          <ul className="flex flex-col gap-2">
            {datos.invitaciones.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{i.email ?? i.phone}</span>
                <Badge role="neutral">{i.rol}</Badge>
                {i.vencida ? (
                  <Badge role="warn">Vencida</Badge>
                ) : (
                  <span className="text-xs text-muted">vence el {cuando(i.expiraEl)}</span>
                )}
                <Button
                  variant="fantasma"
                  size="chico"
                  disabled={quitando === i.id}
                  onClick={() => void cancelar(i)}
                >
                  Cancelar
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
