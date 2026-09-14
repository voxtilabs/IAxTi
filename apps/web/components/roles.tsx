'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Roles personalizados (#73): "recepcionista", "contador", "socio" —
// clonar un base y marcar permisos del catálogo. Los permisos de módulos
// apagados aparecen deshabilitados CON explicación, no escondidos.

interface RolDto {
  id: string;
  name: string;
  base: boolean;
  clonedFrom: string | null;
  permissions: string[];
}

interface PermisoDto {
  permission: string;
  moduleId: string;
  active: boolean;
}

export function Roles() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [roles, setRoles] = useState<RolDto[] | null>(null);
  const [catalogo, setCatalogo] = useState<PermisoDto[]>([]);
  const [nombre, setNombre] = useState('');
  const [clonarDe, setClonarDe] = useState('USER');
  const [editando, setEditando] = useState<RolDto | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setRoles(await apiFetch<RolDto[]>(config, session, tenant, '/roles'));
      setCatalogo(await apiFetch<PermisoDto[]>(config, session, tenant, '/roles/catalogo'));
    } catch (err) {
      setAviso((err as Error).message);
      setRoles([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const clonar = async () => {
    if (!session) return;
    setAviso(null);
    try {
      const rol = await apiFetch<RolDto>(config, session, tenant, '/roles', {
        method: 'POST',
        body: JSON.stringify({ name: nombre, cloneFrom: clonarDe }),
      });
      setNombre('');
      setEditando(rol);
      setMarcados(new Set(rol.permissions));
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  const guardar = async () => {
    if (!session || !editando) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, `/roles/${editando.id}`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: [...marcados] }),
      });
      setEditando(null);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  const porModulo = new Map<string, PermisoDto[]>();
  for (const p of catalogo) {
    porModulo.set(p.moduleId, [...(porModulo.get(p.moduleId) ?? []), p]);
  }

  return (
    <div className="max-w-2xl">
      <p className="rotulo">Roles</p>
      <h1 className="mt-1 font-display text-xl font-bold text-ink">Quién puede qué</h1>
      <p className="mt-2 text-sm text-muted">
        Los cuatro roles base no se tocan. Para el caso especial — la recepcionista, el contador,
        el socio — clona un base y marca exactamente lo que necesita.
      </p>

      <div className="mt-6 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Roles del negocio</span>
        {roles === null ? (
          <Skeleton className="mt-3 h-20" />
        ) : (
          <ul className="mt-2 flex flex-col">
            {roles.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink">{r.name}</p>
                  <p className="dato text-muted">
                    {r.base ? 'Rol base — inmutable' : `Personalizado (desde ${r.clonedFrom}) · ${r.permissions.length} permisos`}
                  </p>
                </div>
                {r.base ? (
                  <Badge role="neutral">Base</Badge>
                ) : (
                  <Button
                    variant="secundario"
                    size="chico"
                    onClick={() => {
                      setEditando(r);
                      setMarcados(new Set(r.permissions));
                    }}
                  >
                    Editar permisos
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Input
            aria-label="Nombre del rol nuevo"
            className="w-48"
            placeholder="Ej: Recepcionista"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <span className="text-sm text-muted">desde</span>
          <Select value={clonarDe} onValueChange={setClonarDe}>
            <SelectTrigger aria-label="Clonar desde" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="USER">USER</SelectItem>
              <SelectItem value="SUPERVISOR">SUPERVISOR</SelectItem>
              <SelectItem value="ADMIN">ADMIN</SelectItem>
            </SelectContent>
          </Select>
          <Button size="chico" disabled={!nombre.trim()} data-testid="clonar-rol" onClick={() => void clonar()}>
            Clonar
          </Button>
        </div>
      </div>

      {editando && (
        <div className="mt-4 rounded-tarjeta border border-action-soft-br bg-action-soft p-6">
          <div className="flex items-baseline justify-between gap-3">
            <span className="rotulo">Permisos de {editando.name}</span>
            <span className="dato text-muted">{marcados.size} marcados</span>
          </div>
          {[...porModulo.entries()].map(([moduleId, permisos]) => (
            <div key={moduleId} className="mt-3">
              <p className="rotulo flex items-center gap-2">
                {moduleId}
                {!permisos[0].active && <Badge role="neutral">módulo apagado</Badge>}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {permisos.map((p) => {
                  const activo = marcados.has(p.permission);
                  return (
                    <button
                      key={p.permission}
                      type="button"
                      disabled={!p.active}
                      aria-pressed={activo}
                      title={
                        p.active
                          ? p.permission
                          : `El módulo ${p.moduleId} está apagado para tu plan: este permiso no tendría efecto.`
                      }
                      className={`dato rounded-boton border px-2 py-1 text-xs ${
                        !p.active
                          ? 'cursor-not-allowed border-line bg-rest text-faint opacity-60'
                          : activo
                            ? 'border-action bg-bg text-action-text'
                            : 'border-line bg-bg text-muted'
                      }`}
                      onClick={() => {
                        const set = new Set(marcados);
                        if (activo) set.delete(p.permission);
                        else set.add(p.permission);
                        setMarcados(set);
                      }}
                    >
                      {p.permission}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="mt-4 flex gap-2">
            <Button data-testid="guardar-rol" onClick={() => void guardar()}>Guardar permisos</Button>
            <Button variant="secundario" onClick={() => setEditando(null)}>Cancelar</Button>
          </div>
        </div>
      )}

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}
    </div>
  );
}
