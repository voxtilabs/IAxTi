'use client';

import { useState } from 'react';
import { Merge } from 'lucide-react';
import { AvisoResultado, Button, Input, useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch, type FichaContacto } from '../../lib/api';

/**
 * Fusionar el duplicado de una persona (#447).
 *
 * `mergeContacts` existe desde #34 —mueve oportunidades, actividades y
 * etiquetas, deja el duplicado apuntando al principal y publica el evento
 * que reapunta las conversaciones— y su ruta no la llamaba nadie.
 *
 * Pasa todo el tiempo: la misma persona escribe por WhatsApp y después por
 * el chat del sitio, o cambia de número. Quedan dos fichas, dos historiales
 * y dos conversaciones de alguien que es uno.
 *
 * La fusión NO se deshace, así que acá lo que importa es que se vea QUÉ se
 * va a mover antes de tocar el botón. Sin eso, el arreglo de un duplicado
 * puede ser peor que el duplicado.
 */
interface Candidato {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export function FusionarDuplicado({
  contactId,
  nombre,
  onFusionado,
}: {
  contactId: string;
  nombre: string | null;
  onFusionado: () => void;
}) {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState('');
  const [candidatos, setCandidatos] = useState<Candidato[] | null>(null);
  const [elegido, setElegido] = useState<Candidato | null>(null);
  const [queTrae, setQueTrae] = useState<{ oportunidades: number; actividades: number } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  if (!tenant) return null;

  const buscar = async () => {
    if (!session || !q.trim()) return;
    setAviso(null);
    setOcupado(true);
    try {
      const res = await apiFetch<{ items: Candidato[] }>(
        config,
        session,
        tenant,
        `/contacts?limit=10&q=${encodeURIComponent(q.trim())}`,
      );
      // El propio contacto no es candidato a duplicado de sí mismo.
      setCandidatos(res.items.filter((c) => c.id !== contactId));
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos buscar.');
    } finally {
      setOcupado(false);
    }
  };

  const elegir = async (c: Candidato) => {
    if (!session) return;
    setElegido(c);
    setQueTrae(null);
    setAviso(null);
    try {
      // Qué trae el duplicado, ANTES de fusionar. La ficha ya lo sabe: no
      // hace falta una ruta nueva para poder mirar antes de saltar.
      const ficha = await apiFetch<FichaContacto>(config, session, tenant, `/contacts/${c.id}`);
      setQueTrae({ oportunidades: ficha.deals.length, actividades: ficha.activities.length });
    } catch {
      /* si no se puede mirar, igual se puede fusionar: se dice sin el detalle */
    }
  };

  const fusionar = async () => {
    if (!session || !elegido) return;
    setAviso(null);
    setOcupado(true);
    try {
      await apiFetch(config, session, tenant, `/contacts/${contactId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ duplicateId: elegido.id }),
      });
      setAbierto(false);
      setElegido(null);
      setCandidatos(null);
      setQ('');
      onFusionado();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos fusionarlos.');
    } finally {
      setOcupado(false);
    }
  };

  if (!abierto) {
    return (
      <div className="mt-3">
        <Button variant="secundario" size="chico" onClick={() => setAbierto(true)}>
          ¿Es la misma persona que otro contacto?
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-campo border border-line bg-bg p-3">
      <p className="flex items-center gap-2">
        <Merge aria-hidden className="size-4 text-muted" />
        <span className="text-sm font-medium text-ink">Fusionar un duplicado en esta ficha</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Lo que tenga el otro contacto pasa acá: sus conversaciones, sus oportunidades, sus
        actividades y sus etiquetas. El otro queda apuntando a este.
      </p>

      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
      >
        <Input
          aria-label="Buscar el contacto duplicado"
          placeholder="Nombre o teléfono del duplicado"
          className="h-9 min-w-56 flex-1 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="secundario" size="chico" disabled={ocupado || !q.trim()}>
          Buscar
        </Button>
        <Button variant="fantasma" size="chico" onClick={() => setAbierto(false)}>
          Cancelar
        </Button>
      </form>

      {candidatos?.length === 0 && (
        <p className="mt-2 text-sm text-muted">Nadie más con ese nombre o teléfono.</p>
      )}

      {candidatos && candidatos.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {candidatos.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => void elegir(c)}
                aria-pressed={elegido?.id === c.id}
                className={[
                  'w-full rounded-campo border px-3 py-2 text-left text-sm transition-colors',
                  elegido?.id === c.id ? 'border-action bg-action-soft' : 'border-line hover:bg-rest',
                ].join(' ')}
              >
                <span className="text-ink">{c.name ?? 'Sin nombre'}</span>{' '}
                <span className="dato text-muted">{c.phone ?? c.email ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {elegido && (
        <div className="mt-3 rounded-campo border border-warn-soft-br bg-warn-soft p-3">
          <p className="text-sm text-warn-text">
            Vas a fusionar <strong>{elegido.name ?? elegido.phone ?? 'ese contacto'}</strong> dentro
            de <strong>{nombre ?? 'esta ficha'}</strong>. <strong>No se puede deshacer.</strong>
          </p>
          {queTrae && (
            <p className="mt-1 text-sm text-body">
              Trae {queTrae.oportunidades} oportunidad{queTrae.oportunidades === 1 ? '' : 'es'} y{' '}
              {queTrae.actividades} actividad{queTrae.actividades === 1 ? '' : 'es'}.
            </p>
          )}
          <Button
            className="mt-2"
            variant="destructivo"
            size="chico"
            disabled={ocupado}
            onClick={() => void fusionar()}
          >
            {ocupado ? 'Fusionando…' : 'Fusionar'}
          </Button>
        </div>
      )}

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}
    </div>
  );
}
