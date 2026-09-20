'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  campaignClient, type Campaign, type CampaignChannel, type CampaignFilters,
  type CampaignListItem, type CampaignPreview, type CampaignResults, type CampaignTemplate,
} from '@iaxti/sdk';
import { Badge, Button, Input, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { impedimentoDeCampana, mismaVistaPrevia } from '../lib/campanas';

const ESTADOS: Record<Campaign['status'], string> = { draft: 'Borrador', sending: 'En curso', done: 'Procesada', cancelled: 'Cancelada' };
const CALIDAD: Record<string, { nombre: string; rol: BadgeRole }> = {
  green: { nombre: 'Buena', rol: 'good' }, yellow: { nombre: 'Media', rol: 'warn' },
  red: { nombre: 'Roja', rol: 'bad' }, desconocida: { nombre: 'Sin confirmar', rol: 'neutral' },
};
const campo = 'h-control w-full min-w-0 rounded-campo border border-line-strong bg-field px-3 text-body';

/** Cambiar de negocio descarta inmediatamente la selección y la vista previa anteriores. */
export function Campanas() {
  const [tenant, setTenant] = useState<string | null>(null);
  useEffect(() => {
    const actualizar = () => setTenant(selectedTenant());
    actualizar();
    window.addEventListener('storage', actualizar);
    return () => window.removeEventListener('storage', actualizar);
  }, []);
  if (!tenant) return <p className="text-muted">Elige un negocio para ver sus campañas.</p>;
  return <CampanasDelNegocio key={tenant} tenant={tenant} />;
}

function CampanasDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const cliente = useMemo(() => session ? campaignClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [lista, setLista] = useState<CampaignListItem[] | null>(null);
  const [truncado, setTruncado] = useState(false);
  const [puedeEscribir, setPuedeEscribir] = useState<boolean | null>(null);
  const [vista, setVista] = useState<'lista' | 'nueva' | 'previa' | 'resultados'>('lista');
  const [plantillas, setPlantillas] = useState<CampaignTemplate[]>([]);
  const [segmentos, setSegmentos] = useState<Array<{ id: string; name: string; filters: CampaignFilters }>>([]);
  const [etiquetas, setEtiquetas] = useState<Array<{ id: string; name: string }>>([]);
  const [campana, setCampana] = useState<Campaign | null>(null);
  const [previa, setPrevia] = useState<CampaignPreview | null>(null);
  const [canales, setCanales] = useState<CampaignChannel[] | null>(null);
  const [resultados, setResultados] = useState<CampaignResults | null>(null);
  const [nombre, setNombre] = useState('');
  const [plantillaId, setPlantillaId] = useState('');
  const [valores, setValores] = useState<string[]>([]);
  const [filtros, setFiltros] = useState<CampaignFilters>({});
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const cerrojo = useRef(false);
  const creacion = useRef<{ cuerpo: string; llave: string } | null>(null);
  const envios = useRef(new Map<string, string>());
  const plantilla = plantillas.find((p) => p.id === plantillaId);

  const cargar = useCallback(async () => {
    if (!cliente) return;
    const [res, acceso] = await Promise.all([cliente.list(), cliente.access()]);
    setPuedeEscribir(acceso.some((m) => m.id === 'automations' && m.acceso === 'completo'));
    setLista(res.campanas); setTruncado(res.truncado);
  }, [cliente]);
  useEffect(() => { void cargar().catch((e: Error) => setError(e.message)); }, [cargar]);

  async function ejecutar(accion: () => Promise<void>) {
    if (cerrojo.current || !cliente) return;
    cerrojo.current = true; setOcupado(true); setError(null);
    try { await accion(); } catch (e) { setError((e as Error).message); }
    finally { cerrojo.current = false; setOcupado(false); }
  }

  async function nueva() {
    if (!puedeEscribir) return;
    await ejecutar(async () => {
      const [ps, ss, es] = await Promise.all([cliente!.templates(), cliente!.segments(), cliente!.tags()]);
      setPlantillas(ps.filter((p) => p.status === 'approved')); setSegmentos(ss); setEtiquetas(es);
      setNombre(''); setPlantillaId(''); setValores([]); setFiltros({});
      setCampana(null); setPrevia(null); setCanales(null); creacion.current = null;
      setVista('nueva');
    });
  }

  async function verPrevia(c: Campaign) {
    setCampana(c); setPrevia(null); setCanales(null); setVista('previa');
    const [p, cs] = await Promise.all([cliente!.preview(c.id), cliente!.channels()]);
    setPrevia(p); setCanales(cs);
  }

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!puedeEscribir) return;
    if (!plantilla || valores.length !== plantilla.variables || valores.some((v) => !v.trim())) return;
    await ejecutar(async () => {
      const body = { name: nombre.trim(), templateId: plantillaId, filtros, valores };
      const cuerpo = JSON.stringify(body);
      if (creacion.current?.cuerpo !== cuerpo) creacion.current = { cuerpo, llave: crypto.randomUUID() };
      const c = await cliente!.create(body, creacion.current.llave);
      await verPrevia(c);
      await cargar();
    });
  }

  async function enviar() {
    if (!puedeEscribir || !campana || !previa || impedimentoDeCampana(canales, previa)) return;
    await ejecutar(async () => {
      // Se vuelve a consultar al enviar: una calidad que cambió mientras se leía no habilita nada.
      const [cs, actual] = await Promise.all([cliente!.channels(), cliente!.preview(campana.id)]);
      setCanales(cs); setPrevia(actual);
      const motivo = impedimentoDeCampana(cs, actual);
      if (motivo) { setError(motivo); return; }
      if (!mismaVistaPrevia(previa, actual)) {
        setError('Los destinatarios cambiaron. Revisa de nuevo el conteo y la muestra antes de enviar.'); return;
      }
      const llave = envios.current.get(campana.id) ?? crypto.randomUUID();
      envios.current.set(campana.id, llave);
      await cliente!.send(campana.id, llave);
      // Desde aquí ya no se ofrece volver a enviar, aunque falle la consulta de resultados.
      setVista('resultados'); setResultados(null);
      setResultados(await cliente!.results(campana.id));
      await cargar();
    });
  }

  const impedimento = puedeEscribir ? impedimentoDeCampana(canales, previa) : 'Tu plan permite consultar campañas, pero no crear ni enviar.';
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="font-display text-2xl font-extrabold text-ink">Campañas</h1>
          <p className="mt-2 text-body">Una plantilla aprobada para un grupo de tus contactos.</p></div>
        {vista === 'lista' ? <Button onClick={() => void nueva()} disabled={ocupado || !puedeEscribir}>Crear campaña</Button> :
          <Button variant="secundario" disabled={ocupado} onClick={() => { setVista('lista'); setError(null); void ejecutar(cargar); }}>Volver al listado</Button>}
      </header>
      {puedeEscribir === false && <p className="text-sm text-muted">Tu plan permite consultar campañas, pero no crear ni enviar. <a href="/ajustes/facturacion">Revisar mi plan</a>.</p>}
      {error && <div role="alert" className="rounded-campo border border-warn-soft-br bg-warn-soft p-4 text-warn-text">{error}</div>}

      {vista === 'lista' && <>
        {lista === null ? <Skeleton className="h-32" /> : lista.length === 0 ?
          <section className="rounded-tarjeta border border-line bg-raised p-6">
            <h2 className="text-lg font-bold text-ink">Todavía no has creado una campaña</h2>
            <p className="mt-2 text-body">Aquí verás tus borradores y los resultados de cada envío. Usa Crear campaña para elegir una plantilla y revisar a quién llegará.</p>
          </section> : <ul className="space-y-3">{lista.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-campo border border-line bg-raised p-4">
            <div className="min-w-0 flex-1"><h2 className="break-words text-lg font-bold text-ink">{c.name}</h2>
              <time dateTime={c.createdAt} className="font-mono text-xs text-muted">{new Date(c.createdAt).toLocaleString('es-CL')}</time>
              <p className="mt-2 text-sm text-body"><span className="font-mono">{c.destinatarios.encolados}</span> encolados · <span className="font-mono">{c.destinatarios.saltados}</span> omitidos · <span className="font-mono">{c.destinatarios.fallados}</span> fallidos</p></div>
            <Badge role={c.status === 'draft' ? 'neutral' : 'info'}>{ESTADOS[c.status]}</Badge>
            <Button variant="secundario" disabled={ocupado} onClick={() => void ejecutar(async () => {
              if (c.status === 'draft') await verPrevia(c);
              else { setCampana(c); setResultados(await cliente!.results(c.id)); setVista('resultados'); }
            })}>{c.status === 'draft' ? 'Revisar borrador' : 'Ver resultados'}</Button>
          </li>)}</ul>}
        {truncado && <p className="text-sm text-muted">Se muestran las campañas más recientes. Hay campañas anteriores fuera de este listado.</p>}
        <Button variant="fantasma" disabled={ocupado} onClick={() => void ejecutar(cargar)}>Actualizar listado</Button>
      </>}

      {vista === 'nueva' && <form onSubmit={(e) => void crear(e)} className="max-w-2xl space-y-5">
        <label className="block text-sm font-medium">Nombre de la campaña<Input required maxLength={150} className="mt-1" value={nombre} onChange={(e) => setNombre(e.target.value)} /></label>
        <label className="block text-sm font-medium">Plantilla aprobada<select required className={`${campo} mt-1`} value={plantillaId} onChange={(e) => {
          setPlantillaId(e.target.value); setValores(Array.from({ length: plantillas.find((p) => p.id === e.target.value)?.variables ?? 0 }, () => ''));
        }}><option value="">Elige una plantilla</option>{plantillas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        {!plantillas.length && <p className="text-sm text-muted">Necesitas una plantilla aprobada por Meta. <a href="/ajustes/plantillas">Revisar plantillas</a>.</p>}
        {plantilla && <blockquote className="whitespace-pre-wrap break-words rounded-campo border border-line bg-raised p-4 text-body">{plantilla.body}</blockquote>}
        {valores.map((v, i) => <label key={i} className="block text-sm font-medium">Valor de la variable <span className="font-mono">{i + 1}</span><Input required className="mt-1" value={v} onChange={(e) => setValores((vs) => vs.map((anterior, n) => n === i ? e.target.value : anterior))} /></label>)}
        {!!valores.length && <p className="text-sm text-muted">Puedes usar {'{contacto.nombre}'} o {'{contacto.telefono}'} para personalizar cada mensaje.</p>}
        <fieldset className="space-y-4 rounded-tarjeta border border-line p-4"><legend className="px-2 font-bold text-ink">Destinatarios</legend>
          {!!segmentos.length && <label className="block text-sm">Partir de un segmento guardado<select className={`${campo} mt-1`} defaultValue="" onChange={(e) => setFiltros(segmentos.find((s) => s.id === e.target.value)?.filters ?? {})}><option value="">Todos los contactos con consentimiento</option>{segmentos.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          <label className="block text-sm">Origen<select className={`${campo} mt-1`} value={filtros.origen ?? ''} onChange={(e) => setFiltros((f) => ({ ...f, origen: e.target.value || undefined }))}><option value="">Cualquier origen</option>{['whatsapp', 'webchat', 'instagram', 'messenger', 'manual', 'importado'].map((origen) => <option key={origen} value={origen}>{origen}</option>)}</select></label>
          <label className="block text-sm">Sin actividad hace al menos (días)<Input type="number" min="0" step="1" className="mt-1 font-mono" value={filtros.sinActividadDias ?? ''} onChange={(e) => setFiltros((f) => ({ ...f, sinActividadDias: e.target.value === '' ? undefined : Number(e.target.value) }))} /></label>
          {!!etiquetas.length && <fieldset><legend className="text-sm">Con todas estas etiquetas</legend><div className="mt-2 flex flex-wrap gap-3">{etiquetas.map((tag) => <label key={tag.id} className="inline-flex min-h-control items-center gap-2 text-sm"><input type="checkbox" checked={filtros.tagIds?.includes(tag.id) ?? false} onChange={(e) => setFiltros((f) => ({ ...f, tagIds: e.target.checked ? [...(f.tagIds ?? []), tag.id] : (f.tagIds ?? []).filter((id) => id !== tag.id) }))} />{tag.name}</label>)}</div></fieldset>}
          <p className="text-sm text-muted">Solo se incluyen contactos con teléfono y consentimiento. Los filtros guardados de etapa y campos propios también se conservan.</p>
        </fieldset>
        <Button type="submit" disabled={ocupado || !plantilla || !nombre.trim()}>{ocupado ? 'Preparando…' : 'Crear borrador y ver destinatarios'}</Button>
      </form>}

      {vista === 'previa' && campana && <section className="space-y-5" aria-label="Vista previa de la campaña">
        <h2 className="break-words text-xl font-bold text-ink">{campana.name}</h2>
        {previa ? <><p><strong className="font-mono text-xl text-ink">{previa.total}</strong> destinatarios en este momento</p>
          <h3 className="font-bold text-ink">Muestra de destinatarios</h3><ul className="space-y-2">{previa.muestra.map((p) => <li key={p.id} className="flex flex-wrap gap-x-3 border-b border-line py-2"><span>{p.name ?? 'Contacto sin nombre'}</span><span className="font-mono text-sm text-muted">{p.phone}</span></li>)}</ul></> : <p role="status">Cargando el conteo y la muestra…</p>}
        <section aria-label="Calidad del número" className="rounded-tarjeta border border-line bg-raised p-4">
          <h3 className="font-bold text-ink">Calidad del número antes de enviar</h3>
          {canales ? canales.filter((c) => c.kind === 'whatsapp').flatMap((c) => c.numbers).map((n) => <div key={n.id} className="mt-3 flex flex-wrap items-center gap-3"><span className="font-mono text-sm">{n.displayPhone ?? 'Número sin teléfono visible'}</span><Badge role={CALIDAD[n.quality ?? 'desconocida'].rol}>{CALIDAD[n.quality ?? 'desconocida'].nombre}</Badge></div>) : <p className="mt-2 text-sm text-muted">Calidad pendiente de comprobar.</p>}
        </section>
        {impedimento && <p id="motivo-campana" className="text-sm text-warn-text">{impedimento}</p>}
        <p className="text-sm text-muted">Los envíos respetan el consentimiento y el horario de silencio. El sistema puede dejarlos en cola hasta el próximo horario permitido.</p>
        <div className="flex flex-wrap gap-3"><Button disabled={ocupado || !!impedimento} aria-describedby={impedimento ? 'motivo-campana' : undefined} onClick={() => void enviar()}>{ocupado ? 'Procesando…' : 'Enviar campaña'}</Button>
          <Button variant="secundario" disabled={ocupado} onClick={() => void ejecutar(() => verPrevia(campana))}>Actualizar vista previa</Button></div>
      </section>}

      {vista === 'resultados' && <section className="space-y-4" aria-label="Resultados de la campaña">
        <h2 className="text-xl font-bold text-ink">Resultados de {resultados?.campana.name ?? campana?.name}</h2>
        {resultados ? <><div className="flex flex-wrap gap-6">{[['Encolados', resultados.porEstado.queued ?? 0], ['Omitidos', resultados.porEstado.skipped ?? 0], ['Fallidos', resultados.porEstado.failed ?? 0]].map(([label, n]) => <p key={label}><span className="block text-sm text-muted">{label}</span><strong className="font-mono text-2xl text-ink">{n}</strong></p>)}</div>
          <h3 className="font-bold text-ink">Por qué no salieron</h3>{resultados.motivos.length ? <ul className="space-y-2">{resultados.motivos.map((m) => <li key={m.motivo} className="rounded-campo border border-line p-3"><span className="font-mono">{m.n}</span> · {m.motivo}</li>)}</ul> : <p className="text-sm text-muted">No se registran destinatarios omitidos ni fallidos.</p>}
          <h3 className="font-bold text-ink">Entrega confirmada por el proveedor</h3><dl className="space-y-2">{Object.entries(resultados.entrega).map(([estado, n]) => <div key={estado} className="flex gap-3"><dt>{({ queued: 'En cola', sent: 'Enviados', delivered: 'Entregados', read: 'Leídos', failed: 'Fallidos' } as Record<string, string>)[estado] ?? estado}</dt><dd className="font-mono">{n}</dd></div>)}</dl>
          <p>Costo registrado: <span className="font-mono">{new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'USD' }).format(resultados.costoUsd)}</span></p>
        </> : <p role="status">Consulta los resultados para ver el estado del envío.</p>}
        <Button variant="secundario" disabled={ocupado || !campana} onClick={() => void ejecutar(async () => { setResultados(await cliente!.results(campana!.id)); })}>Actualizar resultados</Button>
      </section>}
    </div>
  );
}
