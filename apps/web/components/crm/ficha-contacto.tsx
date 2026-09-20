'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, IconoCheck, Input, Skeleton, useSession } from '@iaxti/ui/react';
import type { BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch, fmtClp, type CampoDto, type EtiquetaDto, type FichaContacto as Ficha } from '../../lib/api';

// La ficha de contacto (#32, SPEC §10/§29): historia, oportunidades y
// actividades. La usa la página /contactos/[id] Y el panel derecho de la
// bandeja — una sola ficha, dos lugares. RUT, montos y fechas en mono (§3).

const ESTADO_DEAL: Record<Ficha['deals'][number]['status'], { label: string; role: BadgeRole }> = {
  open: { label: 'Abierta', role: 'action' },
  won: { label: 'Ganada', role: 'good' },
  lost: { label: 'Perdida', role: 'neutral' },
};

const TIPO_ACTIVIDAD: Record<string, string> = {
  llamada: 'Llamada',
  reunion: 'Reunión',
  tarea: 'Tarea',
  nota: 'Nota',
};

function FechaDato({ iso }: { iso: string | null }) {
  if (!iso) return <span className="dato text-faint">—</span>;
  return <span className="dato">{new Date(iso).toLocaleDateString('es-CL')}</span>;
}

/**
 * Los campos propios del negocio (#34).
 *
 * La API ya mandaba `contact.custom` en la ficha y esta pantalla lo tiraba:
 * el dato llegaba al navegador y no se dibujaba en ninguna parte. Se
 * declaran en Ajustes → Campos.
 *
 * Las etiquetas salen de la definición, no de la clave: la clave es interna
 * (`tipo_de_corte`) y lo que el negocio escribió es "Tipo de corte".
 */
function CamposPropios({ valores, definiciones }: {
  valores: Record<string, unknown> | null;
  definiciones: CampoDto[];
}) {
  const conValor = definiciones
    .filter((d) => d.entity === 'contact')
    .map((d) => ({ d, v: valores?.[d.key] }))
    .filter((x) => x.v !== undefined && x.v !== null && x.v !== '');
  if (conValor.length === 0) return null;
  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium text-muted">De tu negocio</h3>
      <dl className="mt-2 flex flex-col gap-1">
        {conValor.map(({ d, v }) => (
          <div key={d.id} className="flex flex-wrap gap-x-3 text-sm">
            <dt className="text-muted">{d.label}</dt>
            <dd className={d.type === 'numero' || d.type === 'moneda' || d.type === 'fecha' ? 'dato text-ink' : 'text-ink'}>
              {d.type === 'si_no' ? (v ? 'Sí' : 'No') : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function FichaContacto({
  contactId,
  compacta = false,
}: {
  contactId: string;
  /** true en el panel de la bandeja: sin encabezado grande. */
  compacta?: boolean;
}) {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [campos, setCampos] = useState<CampoDto[]>([]);
  const [etiquetas, setEtiquetas] = useState<EtiquetaDto[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [titulo, setTitulo] = useState('');
  const [tipo, setTipo] = useState<'llamada' | 'reunion' | 'tarea' | 'nota'>('tarea');
  const [vence, setVence] = useState('');

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant || !contactId) return;
    try {
      setFicha(await apiFetch<Ficha>(config, session, tenant, `/contacts/${contactId}`));
      // Las definiciones aparte: sin ellas los valores son claves sueltas
      // sin nombre. Si fallan, la ficha se dibuja igual sin esa sección.
      try {
        setCampos(await apiFetch<CampoDto[]>(config, session, tenant, '/campos'));
      } catch {
        setCampos([]);
      }
      // Las etiquetas del contacto (#35). Si fallan, la ficha se dibuja
      // igual: son contexto, no el dato principal.
      try {
        setEtiquetas(
          await apiFetch<EtiquetaDto[]>(config, session, tenant, `/tags/contacto/${contactId}`),
        );
      } catch {
        setEtiquetas([]);
      }
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant, contactId]);
  useEffect(() => void cargar(), [cargar]);

  async function agregarActividad(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || !titulo.trim()) return;
    try {
      await apiFetch(config, session, tenant, `/contacts/${contactId}/activities`, {
        method: 'POST',
        body: JSON.stringify({ type: tipo, title: titulo.trim(), dueAt: vence || undefined }),
      });
      setTitulo('');
      setVence('');
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  async function marcarHecha(id: string) {
    if (!session || !tenant) return;
    await apiFetch(config, session, tenant, `/contacts/activities/${id}/done`, { method: 'POST' })
      .then(cargar)
      .catch((err) => setAviso((err as Error).message));
  }

  if (aviso) {
    return (
      <AvisoResultado persistente>
        {aviso}
      </AvisoResultado>
    );
  }
  if (!ficha) {
    return <div className="flex flex-col gap-3"><Skeleton className="h-10" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  }

  const { contact, deals, activities } = ficha;

  return (
    <div className={compacta ? '' : 'max-w-2xl'}>
      {!compacta && (
        <>
          <p className="rotulo">Contacto</p>
          <h2 className="mt-1 text-2xl font-bold text-ink">{contact.name ?? 'Sin nombre aún'}</h2>
        </>
      )}

      {/* Datos: RUT y teléfono SIEMPRE en mono (§3). */}
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Teléfono</dt>
        <dd className="dato text-ink">{contact.phone}</dd>
        {contact.rut && (<><dt className="text-muted">RUT</dt><dd className="dato text-ink">{contact.rut}</dd></>)}
        {contact.email && (<><dt className="text-muted">Correo</dt><dd className="text-body">{contact.email}</dd></>)}
        <dt className="text-muted">Origen</dt>
        <dd><Badge role="neutral">{contact.origin}</Badge></dd>
        <dt className="text-muted">Cliente desde</dt>
        <dd><FechaDato iso={contact.created_at} /></dd>
      </dl>

      {etiquetas.length > 0 && (
        <p className="mt-4 flex flex-wrap gap-2">
          {etiquetas.map((t) => (
            <Badge key={t.id} role={t.role}>
              {t.name}
            </Badge>
          ))}
        </p>
      )}

      <CamposPropios valores={contact.custom} definiciones={campos} />

      {/* Oportunidades (montos en mono). */}
      <section className="mt-6">
        <p className="rotulo">Oportunidades</p>
        {deals.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Sin oportunidades todavía.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {deals.map((d) => (
              <li key={d.id} className="flex items-center gap-3 rounded-campo border border-line bg-raised px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.title}</span>
                  <span className="block text-xs text-muted">{d.pipeline_name} · {d.stage_name}</span>
                </span>
                {d.stalled && d.status === 'open' && <Badge role="warn">Estancada</Badge>}
                <Badge role={ESTADO_DEAL[d.status].role}>{ESTADO_DEAL[d.status].label}</Badge>
                <span className="dato text-ink">{d.currency === 'UF' && d.value ? `UF ${d.value}` : fmtClp(d.value_clp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Actividades. */}
      <section className="mt-6">
        <p className="rotulo">Actividades</p>
        <ul className="mt-2 flex flex-col gap-2">
          {activities.map((a) => (
            <li key={a.id} className="flex items-center gap-3 rounded-campo border border-line px-4 py-2">
              <Badge role={a.doneAt ? 'good' : a.dueAt && new Date(a.dueAt) < new Date() ? 'warn' : 'neutral'}>
                {TIPO_ACTIVIDAD[a.type]}
              </Badge>
              <span className={`min-w-0 flex-1 truncate text-sm ${a.doneAt ? 'text-muted line-through' : 'text-body'}`}>
                {a.title}
              </span>
              {a.dueAt && <FechaDato iso={a.dueAt} />}
              {!a.doneAt && (
                <Button variant="fantasma" size="icono" aria-label={`Marcar hecha: ${a.title}`} onClick={() => void marcarHecha(a.id)}>
                  <IconoCheck className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        <form onSubmit={agregarActividad} className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label="Tipo de actividad"
            className="h-9 rounded-campo border border-line-strong bg-field px-3 text-sm text-ink"
            value={tipo}
            onChange={(e) => setTipo(e.target.value as typeof tipo)}
          >
            {Object.entries(TIPO_ACTIVIDAD).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <Input
            aria-label="Título de la actividad"
            placeholder="Nueva actividad…"
            className="h-9 min-w-40 flex-1 text-sm"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
          />
          <Input
            type="datetime-local"
            aria-label="Vencimiento"
            className="dato h-9 w-52 text-sm"
            value={vence}
            onChange={(e) => setVence(e.target.value)}
          />
          <Button type="submit" variant="secundario" size="chico" disabled={!titulo.trim()}>
            Agregar
          </Button>
        </form>
      </section>

      {/* Espacio reservado para la IA (Fase 3), con rótulo mono (#32). */}
      <section className="mt-6 rounded-campo border border-line bg-rest p-4">
        <p className="rotulo">Acciones de la IA</p>
        <p className="mt-1 text-sm text-muted">
          Cuando conectes el asistente, aquí queda cada acción que tome con este contacto, con su
          explicación.
        </p>
      </section>
    </div>
  );
}
