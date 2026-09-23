'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconoCheck,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useSession,
} from '@iaxti/ui/react';
import type { BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { DerechosDelTitular } from './derechos-del-titular';
import { FusionarDuplicado } from './fusionar-duplicado';
import { apiFetch, fmtClp, type CampoDto, type EtiquetaDto, type FichaContacto as Ficha } from '../../lib/api';

/** «Sin empresa» necesita un valor: Radix no acepta la cadena vacía. */
const SIN_EMPRESA = '__sin_empresa__';

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
  const [empresas, setEmpresas] = useState<Array<{ id: string; name: string }>>([]);
  const [guardandoEmpresa, setGuardandoEmpresa] = useState(false);
  /** El catálogo del negocio, para ofrecer cuáles se pueden poner. */
  const [catalogo, setCatalogo] = useState<EtiquetaDto[]>([]);
  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [borrador, setBorrador] = useState<{
    name: string;
    email: string;
    rut: string;
    custom: Record<string, unknown>;
  }>({ name: '', email: '', rut: '', custom: {} });
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
      // El catálogo de etiquetas, para ofrecer cuáles poner. Si falla, se
      // siguen viendo las que el contacto ya tiene.
      try {
        setCatalogo(await apiFetch<EtiquetaDto[]>(config, session, tenant, '/tags'));
      } catch {
        setCatalogo([]);
      }
      // Las empresas para el selector. Si el módulo o el permiso no están,
      // el selector queda con lo que ya tiene puesto y nada más.
      try {
        setEmpresas(
          await apiFetch<Array<{ id: string; name: string }>>(config, session, tenant, '/empresas'),
        );
      } catch {
        setEmpresas([]);
      }
    } catch (err) {
      setAviso((err as Error).message);
    }
  }, [config, session, tenant, contactId]);
  useEffect(() => void cargar(), [cargar]);

  /**
   * Guarda las correcciones. Lo vacío viaja como `null` y no como cadena:
   * "sin correo" y "correo en blanco" son cosas distintas, y el servidor
   * distingue.
   */
  async function guardarDatos() {
    if (!session || !tenant || !contactId || guardando) return;
    setGuardando(true);
    try {
      await apiFetch(config, session, tenant, `/contacts/${contactId}`, {
        method: 'PATCH',
        // Vacío viaja como `null` y eso BORRA; no mandar el campo lo
        // dejaría como estaba, que es justo lo contrario de lo que pidió
        // quien borró el correo en pantalla.
        body: JSON.stringify({
          name: borrador.name.trim() || null,
          email: borrador.email.trim() || null,
          rut: borrador.rut.trim() || null,
          custom: borrador.custom,
        }),
      });
      setAviso(null);
      setEditando(false);
      await cargar();
    } catch (err) {
      // El RUT malo, una opción fuera de la lista o un obligatorio vacío:
      // el mensaje del dominio ya explica cuál, y se muestra tal cual.
      setAviso((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  /** Deja al contacto con exactamente estas etiquetas. */
  async function cambiarEtiquetas(tagIds: string[]) {
    if (!session || !tenant || !contactId) return;
    try {
      await apiFetch(config, session, tenant, `/tags/contacto/${contactId}`, {
        method: 'PUT',
        body: JSON.stringify({ tagIds }),
      });
      setAviso(null);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  /** Cuelga el contacto de una empresa, o lo baja de la que tenía. */
  async function asignarEmpresa(companyId: string | null) {
    if (!session || !tenant || !contactId || guardandoEmpresa) return;
    setGuardandoEmpresa(true);
    try {
      await apiFetch(config, session, tenant, `/contacts/${contactId}/empresa`, {
        method: 'PUT',
        body: JSON.stringify({ companyId }),
      });
      setAviso(null);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setGuardandoEmpresa(false);
    }
  }

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
        {/* De qué empresa es (#460). `PUT /contacts/:id/empresa` existía
            desde #217 y no la llamaba nadie: las empresas se creaban y
            ningún contacto se podía colgar de una, así que la pantalla de
            Empresas mostraba fichas vacías para siempre. */}
        <dt className="text-muted">Empresa</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <Select
            value={contact.company_id ?? SIN_EMPRESA}
            disabled={guardandoEmpresa}
            onValueChange={(valor) => void asignarEmpresa(valor === SIN_EMPRESA ? null : valor)}
          >
            <SelectTrigger className="h-9 w-56 bg-field text-sm" aria-label="Empresa del contacto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Radix no acepta el valor vacío como opción, así que "sin
                  empresa" viaja con centinela y se traduce a null al salir:
                  el servidor distingue null —descolgar— de un id. */}
              <SelectItem value={SIN_EMPRESA}>Sin empresa</SelectItem>
              {/* La que tiene puesta va sí o sí, aunque esté archivada: si
                  no, el selector la mostraría como "Sin empresa" y el
                  primer cambio la borraría sin que nadie lo pidiera. */}
              {contact.company_id && !empresas.some((e) => e.id === contact.company_id) && (
                <SelectItem value={contact.company_id}>
                  {contact.company_name ?? 'La que tiene hoy'}
                </SelectItem>
              )}
              {empresas.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {contact.company_id && (
            <a className="text-sm text-action-text underline" href={`/empresas/${contact.company_id}`}>
              Ver la empresa
            </a>
          )}
        </dd>
      </dl>

      {/* Etiquetar desde la ficha (#480). `PUT /tags/contacto/:contactId`
          existe desde #35 y no la llamaba nadie: las etiquetas se creaban,
          se veían en la bandeja y no había dónde ponérselas a alguien.
          La ruta deja al contacto con EXACTAMENTE las que se manden, así
          que se manda la lista completa de lo que quedó marcado. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {etiquetas.map((t) => (
          <Badge key={t.id} role={t.role}>
            {t.name}
          </Badge>
        ))}
        {etiquetas.length === 0 && <span className="text-sm text-muted">Sin etiquetas.</span>}
        {catalogo.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="fantasma" size="chico">Etiquetar</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Etiquetas del negocio</DropdownMenuLabel>
              {catalogo.map((t) => {
                const puesta = etiquetas.some((e) => e.id === t.id);
                return (
                  <DropdownMenuItem
                    key={t.id}
                    // `onSelect` con preventDefault: marcar varias seguidas
                    // sin que el menú se cierre en cada una.
                    onSelect={(e) => {
                      e.preventDefault();
                      void cambiarEtiquetas(
                        puesta
                          ? etiquetas.filter((x) => x.id !== t.id).map((x) => x.id)
                          : [...etiquetas.map((x) => x.id), t.id],
                      );
                    }}
                  >
                    {/* Un icono y no un carácter: Pulso prohíbe los emoji
                        porque se dibujan con la fuente del sistema, no
                        heredan el color ni escalan con la tipografía. */}
                    <span className="mr-2 flex w-4 justify-center">
                      {puesta && <IconoCheck className="h-3.5 w-3.5 text-action-text" />}
                    </span>
                    {t.name}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Corregir los datos (#480). `PATCH /contacts/:id` existe desde #34
          y no la llamaba nadie: un nombre mal escrito, un correo o un RUT
          solo se arreglaban volviendo a importar la planilla, y los campos
          propios del negocio solo se podían llenar en la importación. */}
      {editando ? (
        <form
          className="mt-6 flex flex-col gap-3 rounded-tarjeta border border-line bg-raised p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void guardarDatos();
          }}
        >
          <h3 className="text-sm font-medium text-ink">Corregir los datos</h3>
          <label className="flex flex-col gap-1 text-sm text-body">
            Nombre
            <Input value={borrador.name} onChange={(e) => setBorrador({ ...borrador, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Correo
            <Input
              type="email"
              value={borrador.email}
              onChange={(e) => setBorrador({ ...borrador, email: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            RUT
            <Input
              className="dato"
              value={borrador.rut}
              onChange={(e) => setBorrador({ ...borrador, rut: e.target.value })}
            />
            <span className="text-xs text-muted">
              El servidor lo valida y lo guarda normalizado; si está malo, lo dice.
            </span>
          </label>
          {campos
            .filter((d) => d.entity === 'contact')
            .map((d) => (
              <label key={d.id} className="flex flex-col gap-1 text-sm text-body">
                {d.label}
                {d.required && <span className="sr-only"> (obligatorio)</span>}
                {d.type === 'si_no' ? (
                  // Sí/no viaja como BOOLEANO, no como la palabra: el
                  // servidor rechaza 'true' con «es de sí o no», y el
                  // rechazo llegaría recién al guardar.
                  <span className="flex gap-2">
                    {[
                      { v: true, t: 'Sí' },
                      { v: false, t: 'No' },
                      { v: undefined, t: 'Sin responder' },
                    ].map((o) => (
                      <Button
                        key={o.t}
                        type="button"
                        size="chico"
                        variant={borrador.custom[d.key] === o.v ? 'secundario' : 'fantasma'}
                        aria-pressed={borrador.custom[d.key] === o.v}
                        onClick={() =>
                          setBorrador({ ...borrador, custom: { ...borrador.custom, [d.key]: o.v } })
                        }
                      >
                        {o.t}
                      </Button>
                    ))}
                  </span>
                ) : (
                  <Input
                    type={d.type === 'numero' || d.type === 'moneda' ? 'number' : d.type === 'fecha' ? 'date' : 'text'}
                    list={d.type === 'lista' ? `opciones-${d.id}` : undefined}
                    className={d.type === 'texto' || d.type === 'lista' ? '' : 'dato'}
                    value={String(borrador.custom[d.key] ?? '')}
                    onChange={(e) =>
                      setBorrador({ ...borrador, custom: { ...borrador.custom, [d.key]: e.target.value } })
                    }
                  />
                )}
                {/* Las opciones se ofrecen pero no se imponen: el servidor
                    es quien rechaza una fuera de la lista, y su mensaje
                    dice cuál es la lista. */}
                {d.type === 'lista' && (
                  <datalist id={`opciones-${d.id}`}>
                    {d.options.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                )}
              </label>
            ))}
          <span className="flex flex-wrap gap-2">
            <Button type="submit" disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </Button>
            <Button type="button" variant="secundario" onClick={() => setEditando(false)}>
              Dejar como estaba
            </Button>
          </span>
        </form>
      ) : (
        <>
          <CamposPropios valores={contact.custom} definiciones={campos} />
          <span className="mt-4 block">
            <Button
              variant="secundario"
              size="chico"
              onClick={() => {
                setBorrador({
                  name: contact.name ?? '',
                  email: contact.email ?? '',
                  rut: contact.rut ?? '',
                  custom: { ...(contact.custom ?? {}) },
                });
                setEditando(true);
              }}
            >
              Corregir los datos
            </Button>
          </span>
        </>
      )}

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
          <Select value={tipo} onValueChange={(valor) => setTipo(valor as typeof tipo)}>
            <SelectTrigger className="h-9 bg-field text-sm" aria-label="Tipo de actividad">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TIPO_ACTIVIDAD).map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      {/* Los derechos de la persona, en su ficha y no escondidos en un
          menú: quien recibe la solicitud llega por acá (#447). En el panel
          de la bandeja no van: ahí se está atendiendo, no administrando. */}
      {/* Fusionar duplicados (#447): pasa todo el tiempo —la misma
          persona escribe por WhatsApp y después por el chat del sitio— y
          `mergeContacts` existía desde #34 sin puerta. Va acá arriba de los
          derechos porque es operación diaria, no un trámite. */}
      {!compacta && (
        <FusionarDuplicado contactId={contactId} nombre={ficha.contact.name} onFusionado={cargar} />
      )}

      {!compacta && <DerechosDelTitular contactId={contactId} nombre={ficha.contact.name} />}

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
