'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// API keys (#24, SPEC §7/§8): el cliente se integra solo. El token se ve
// UNA vez (en mono, con el aviso de copiarlo AHORA); acá después solo
// queda el nombre, los scopes y el último uso.

interface ConsumoDto {
  limit: number | null;
  used: number;
  pct: number | null;
  porDia: Array<{ day: string; n: number }>;
  topEndpoints: Array<{ endpoint: string; n: number }>;
}

interface KeyDto {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function ApiKeys() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyDto[] | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [nombre, setNombre] = useState('');
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());
  const [vence, setVence] = useState('');
  const [tokenNuevo, setTokenNuevo] = useState<string | null>(null);
  const [consumo, setConsumo] = useState<ConsumoDto | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setKeys(await apiFetch<KeyDto[]>(config, session, tenant, '/apikeys'));
      setScopes(await apiFetch<string[]>(config, session, tenant, '/apikeys/scopes'));
      setConsumo(await apiFetch<ConsumoDto>(config, session, tenant, '/api-usage').catch(() => null));
    } catch (err) {
      setAviso((err as Error).message);
      setKeys([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const crear = async () => {
    if (!session) return;
    setAviso(null);
    try {
      const res = await apiFetch<{ token: string }>(config, session, tenant, '/apikeys', {
        method: 'POST',
        body: JSON.stringify({
          name: nombre,
          scopes: [...elegidos],
          expiresAt: vence || undefined,
        }),
      });
      setTokenNuevo(res.token);
      setNombre('');
      setElegidos(new Set());
      setVence('');
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  const revocar = async (id: string) => {
    if (!session) return;
    try {
      await apiFetch(config, session, tenant, `/apikeys/${id}`, { method: 'DELETE' });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <p className="rotulo">API</p>
      <h1 className="mt-1 font-display text-titulo font-bold text-ink">Tus llaves de integración</h1>
      <p className="mt-2 text-sm text-muted">
        Conecta tus sistemas a la API de IAxTi con llaves propias. Cada llave puede SOLO lo que le
        des — nunca más que los permisos de tu cuenta. Va en el header{' '}
        <span className="dato">X-Api-Key</span>.
      </p>

      {tokenNuevo && (
        <div className="mt-6 rounded-tarjeta border border-warn-soft-br bg-warn-soft p-6">
          <p className="rotulo">Cópialo AHORA — no lo verás de nuevo</p>
          <p className="dato mt-2 break-all rounded-campo border border-line bg-bg p-3 text-sm text-ink" data-testid="token-nuevo">
            {tokenNuevo}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(tokenNuevo);
              }}
            >
              Copiar
            </Button>
            <Button variant="secundario" onClick={() => setTokenNuevo(null)}>Ya lo guardé</Button>
          </div>
        </div>
      )}

      <div className="mt-6 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Nueva llave</span>
        <div className="mt-3 flex flex-wrap gap-3">
          <Input
            aria-label="Nombre de la llave"
            className="w-64"
            placeholder="Ej: Integración ERP"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-body">
            Vence
            <Input aria-label="Expiración" type="date" className="w-40" value={vence} onChange={(e) => setVence(e.target.value)} />
          </label>
        </div>
        <p className="rotulo mt-4">Permisos (scopes)</p>
        <div className="mt-2 flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {scopes.map((s) => {
            const activo = elegidos.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={activo}
                className={`dato rounded-boton border px-2 py-1 text-xs ${
                  activo ? 'border-action bg-action-soft text-action-text' : 'border-line bg-bg text-muted'
                }`}
                onClick={() => {
                  const set = new Set(elegidos);
                  if (activo) set.delete(s);
                  else set.add(s);
                  setElegidos(set);
                }}
              >
                {s}
              </button>
            );
          })}
        </div>
        <Button
          className="mt-4"
          disabled={!nombre.trim() || elegidos.size === 0}
          data-testid="crear-apikey"
          onClick={() => void crear()}
        >
          Crear llave
        </Button>
      </div>

      <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Llaves</span>
        {keys === null ? (
          <Skeleton className="mt-3 h-16" />
        ) : keys.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Todavía no hay llaves.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">{k.name}</p>
                  <p className="dato text-muted">
                    {k.scopes.length} permisos
                    {k.lastUsedAt
                      ? ` · último uso ${new Date(k.lastUsedAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                      : ' · sin uso todavía'}
                    {k.expiresAt && ` · vence ${new Date(k.expiresAt).toLocaleDateString('es-CL')}`}
                  </p>
                </div>
                {k.revokedAt ? (
                  <Badge role="neutral">Revocada</Badge>
                ) : (
                  <>
                    <Badge role="good">Activa</Badge>
                    <Button variant="fantasma" size="chico" onClick={() => void revocar(k.id)}>
                      Revocar
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {consumo && (
        <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
          <div className="flex items-baseline justify-between gap-4">
            <span className="rotulo">Consumo del mes</span>
            {consumo.pct !== null && consumo.pct >= 80 && (
              <Badge role={consumo.pct >= 100 ? 'bad' : 'warn'}>Al {consumo.pct} %</Badge>
            )}
          </div>
          <p className="dato mt-2 text-3xl font-bold text-ink">
            {consumo.used.toLocaleString('es-CL')}
            {consumo.limit !== null && (
              <span className="text-lg text-muted"> / {consumo.limit.toLocaleString('es-CL')}</span>
            )}
          </p>
          {consumo.limit !== null && (
            <div className="mt-3 h-2 overflow-hidden rounded-boton bg-rest" role="progressbar"
                 aria-valuenow={Math.min(consumo.pct ?? 0, 100)} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`h-full rounded-boton ${(consumo.pct ?? 0) >= 100 ? 'bg-bad' : (consumo.pct ?? 0) >= 80 ? 'bg-warn' : 'bg-action'}`}
                style={{ width: `${Math.min(consumo.pct ?? 0, 100)}%` }}
              />
            </div>
          )}
          {consumo.topEndpoints.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1">
              {consumo.topEndpoints.slice(0, 5).map((e) => (
                <li key={e.endpoint} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="dato truncate text-muted">{e.endpoint}</span>
                  <span className="dato shrink-0 text-body">{e.n.toLocaleString('es-CL')}</span>
                </li>
              ))}
            </ul>
          )}
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
