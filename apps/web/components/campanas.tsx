'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, type EtiquetaDto, type PlantillaDto } from '../lib/api';

// Campañas (#75, SPEC §24).
//
// Es la función que más rápido puede arruinarle la reputación a un negocio,
// y hasta ahora solo se podía usar con curl. Las tres protecciones que el
// módulo ya tenía escritas no servían de nada si nadie las veía:
//
//  1. La vista previa sale de la MISMA consulta que después elige a quién
//     se le manda. Acá es obligatoria: sin verla no se habilita "Enviar".
//  2. Cada destinatario queda con su resultado y su motivo. Los saltados se
//     muestran con el motivo escrito, no como un número.
//  3. Con el número en rojo la campaña no sale. Se dice antes, no después.

interface CampanaDto {
  id: string;
  name: string;
  templateId: string;
  status: 'draft' | 'sending' | 'done' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  destinatarios: { encolados: number; saltados: number; fallados: number };
}

interface ListadoDto {
  campanas: CampanaDto[];
  truncado: boolean;
}

interface VistaPreviaDto {
  total: number;
  muestra: Array<{ id: string; name: string | null; phone: string | null }>;
}

interface ResultadosDto {
  campana: { id: string; name: string; status: CampanaDto['status'] };
  porEstado: Record<string, number>;
  motivos: Array<{ motivo: string; n: number }>;
  entrega: Record<string, number>;
  costoUsd: number;
}

interface CanalDto {
  kind: string;
  numbers: Array<{ quality: 'green' | 'yellow' | 'red' | null }>;
}

const ESTADO: Record<CampanaDto['status'], { texto: string; rol: BadgeRole }> = {
  draft: { texto: 'Borrador', rol: 'neutral' },
  sending: { texto: 'Enviando', rol: 'action' },
  done: { texto: 'Enviada', rol: 'good' },
  cancelled: { texto: 'Cancelada', rol: 'neutral' },
};

const CALIDAD: Record<'green' | 'yellow' | 'red', { texto: string; rol: BadgeRole; ayuda: string }> = {
  green: {
    texto: 'Calidad buena',
    rol: 'good',
    ayuda: 'Meta ve buenas respuestas de tus clientes.',
  },
  yellow: {
    texto: 'Calidad media',
    rol: 'warn',
    ayuda: 'Algunos clientes reportaron o bloquearon mensajes. Cuida el contenido y la frecuencia.',
  },
  red: {
    texto: 'Calidad baja',
    rol: 'bad',
    ayuda:
      'Con el número en rojo la campaña no sale: mandarle promoción a mucha gente desde un número que Meta está mirando es la forma más corta de perderlo. Responder conversaciones sigue funcionando.',
  },
};

function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function Campanas() {
  const { config, session } = useSession();
  const tenant = selectedTenant();

  const [listado, setListado] = useState<ListadoDto | null>(null);
  const [plantillas, setPlantillas] = useState<PlantillaDto[]>([]);
  const [etiquetas, setEtiquetas] = useState<EtiquetaDto[]>([]);
  const [calidad, setCalidad] = useState<'green' | 'yellow' | 'red' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<{ name: string; templateId: string; tagIds: string[]; sinActividadDias: string }>(
    { name: '', templateId: '', tagIds: [], sinActividadDias: '' },
  );
  // La vista previa del segmento ANTES de crear nada: es lo que deja mirar
  // sin comprometerse.
  const [previa, setPrevia] = useState<VistaPreviaDto | null>(null);
  const [mirando, setMirando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultados, setResultados] = useState<ResultadosDto | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [l, p, e, c] = await Promise.all([
        apiFetch<ListadoDto>(config, session, tenant, '/campanas'),
        apiFetch<PlantillaDto[]>(config, session, tenant, '/plantillas').catch(() => []),
        apiFetch<EtiquetaDto[]>(config, session, tenant, '/etiquetas').catch(() => []),
        apiFetch<CanalDto[]>(config, session, tenant, '/canales').catch(() => []),
      ]);
      setListado(l);
      setPlantillas(p);
      setEtiquetas(e);
      const wa = c.find((x) => x.kind === 'whatsapp');
      setCalidad(wa?.numbers?.[0]?.quality ?? null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setListado({ campanas: [], truncado: false });
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const aprobadas = useMemo(() => plantillas.filter((p) => p.status === 'approved'), [plantillas]);

  const filtros = useMemo(() => {
    const dias = Number(form.sinActividadDias);
    return {
      ...(form.tagIds.length > 0 ? { tagIds: form.tagIds } : {}),
      ...(Number.isFinite(dias) && dias > 0 ? { sinActividadDias: dias } : {}),
    };
  }, [form.tagIds, form.sinActividadDias]);

  // Cambiar el segmento invalida lo que ya se vio: si no, se mira un
  // segmento y se manda otro.
  useEffect(() => {
    setPrevia(null);
  }, [filtros]);

  async function verAQuienLeLlega() {
    if (!session || !tenant || mirando) return;
    setMirando(true);
    try {
      setPrevia(
        await apiFetch<VistaPreviaDto>(config, session, tenant, '/campanas/segmentos/vista-previa', {
          method: 'POST',
          body: JSON.stringify({ filtros }),
        }),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMirando(false);
    }
  }

  async function crearYEnviar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || enviando || !previa) return;
    setEnviando(true);
    try {
      const creada = await apiFetch<{ id: string }>(config, session, tenant, '/campanas', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, templateId: form.templateId, filtros }),
      });
      await apiFetch(config, session, tenant, `/campanas/${creada.id}/enviar`, { method: 'POST' });
      setForm({ name: '', templateId: '', tagIds: [], sinActividadDias: '' });
      setPrevia(null);
      setError(null);
      await cargar();
      await verResultados(creada.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  async function verResultados(id: string) {
    if (!session || !tenant) return;
    try {
      setResultados(await apiFetch<ResultadosDto>(config, session, tenant, `/campanas/${id}/resultados`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (listado === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const enRojo = calidad === 'red';
  const listaParaEnviar = Boolean(previa && form.name.trim() && form.templateId && !enRojo);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="font-display text-titulo text-ink">Campañas</h1>
        <p className="mt-1 max-w-2xl text-sm text-body">
          Una plantilla aprobada a un grupo de tu cartera. Antes de mandar nada ves exactamente a
          cuántas personas le llega y quiénes son.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-sm text-bad-text"
        >
          {error}
        </p>
      )}

      {calidad && (
        <div className="flex flex-col gap-2 rounded-tarjeta border border-line bg-raised p-5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">Tu número de WhatsApp</span>
            <Badge role={CALIDAD[calidad].rol}>{CALIDAD[calidad].texto}</Badge>
          </div>
          <p className="text-sm text-body">{CALIDAD[calidad].ayuda}</p>
        </div>
      )}

      <form onSubmit={crearYEnviar} className="flex flex-col gap-4 rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">Nueva campaña</h2>

        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Nombre
          <Input
            required
            value={form.name}
            onChange={(ev) => setForm({ ...form, name: ev.target.value })}
            placeholder="Promo de invierno"
          />
          <span className="text-xs text-muted">Es para ti: el cliente no lo ve.</span>
        </label>

        <fieldset className="flex flex-col gap-1 text-sm font-medium text-ink">
          <legend className="mb-1">Plantilla</legend>
          {aprobadas.length === 0 ? (
            <p className="text-sm text-body">
              No tienes plantillas aprobadas todavía. Fuera de las 24 horas desde el último mensaje
              del cliente, WhatsApp solo deja escribir con una que Meta haya aprobado.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {aprobadas.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  variant={form.templateId === p.id ? 'secundario' : 'fantasma'}
                  size="chico"
                  aria-pressed={form.templateId === p.id}
                  onClick={() => setForm({ ...form, templateId: p.id })}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2 text-sm font-medium text-ink">
          <legend>A quién</legend>
          {etiquetas.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {etiquetas.map((t) => {
                const puesta = form.tagIds.includes(t.id);
                return (
                  <Button
                    key={t.id}
                    type="button"
                    variant={puesta ? 'secundario' : 'fantasma'}
                    size="chico"
                    aria-pressed={puesta}
                    onClick={() =>
                      setForm({
                        ...form,
                        tagIds: puesta ? form.tagIds.filter((x) => x !== t.id) : [...form.tagIds, t.id],
                      })
                    }
                  >
                    {t.name}
                  </Button>
                );
              })}
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-normal text-body">
            Sin actividad hace al menos
            <span className="flex items-center gap-2">
              <Input
                className="dato w-24"
                inputMode="numeric"
                value={form.sinActividadDias}
                onChange={(ev) => setForm({ ...form, sinActividadDias: ev.target.value })}
                placeholder="30"
              />
              <span>días</span>
            </span>
          </label>
          <span className="text-xs text-muted">
            Sin filtros le llega a toda tu cartera que haya dado consentimiento. Quien se dio de baja
            no entra nunca, ni en el conteo.
          </span>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secundario" onClick={verAQuienLeLlega} disabled={mirando}>
            {mirando ? 'Contando…' : 'Ver a quién le llega'}
          </Button>
          <Button type="submit" variant="primario" disabled={!listaParaEnviar || enviando}>
            {enviando ? 'Enviando…' : 'Enviar campaña'}
          </Button>
        </div>

        {!previa && (
          <p className="text-xs text-muted">
            Para poder enviar, primero mira a quién le llega.
          </p>
        )}
        {enRojo && (
          <p className="text-sm text-bad-text">
            Con el número en rojo no se puede enviar. Cuida la frecuencia y el contenido unos días.
          </p>
        )}

        {previa && (
          <div className="flex flex-col gap-2 rounded-campo border border-line bg-bg p-4">
            <p className="text-sm text-ink">
              Le llega a <span className="dato font-bold">{previa.total}</span>{' '}
              {previa.total === 1 ? 'persona' : 'personas'}.
            </p>
            {previa.muestra.length > 0 && (
              <ul className="flex flex-col gap-1">
                {previa.muestra.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline gap-2 text-sm text-body">
                    <span>{c.name ?? 'Sin nombre'}</span>
                    <span className="dato text-xs text-muted">{c.phone ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
            {previa.total > previa.muestra.length && (
              <p className="text-xs text-muted">
                Se muestran {previa.muestra.length} de {previa.total}.
              </p>
            )}
          </div>
        )}
      </form>

      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-ink">Las que ya mandaste</h2>
        {listado.campanas.length === 0 ? (
          <p className="rounded-tarjeta border border-line bg-raised p-5 text-sm text-body">
            Todavía no hay campañas. Cuando mandes la primera vas a ver acá cómo le fue: a cuántos
            les llegó y, de los que no, por qué.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {listado.campanas.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-tarjeta border border-line bg-raised p-4"
              >
                <div className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{c.name}</span>
                    <Badge role={ESTADO[c.status].rol}>{ESTADO[c.status].texto}</Badge>
                  </span>
                  <span className="text-sm text-body">
                    <span className="dato">{c.destinatarios.encolados}</span> enviados ·{' '}
                    <span className="dato">{c.destinatarios.saltados}</span> saltados
                    {c.destinatarios.fallados > 0 && (
                      <>
                        {' '}
                        · <span className="dato">{c.destinatarios.fallados}</span> con error
                      </>
                    )}
                  </span>
                  <span className="dato text-xs text-muted">{fecha(c.startedAt ?? c.createdAt)}</span>
                </div>
                <Button type="button" variant="fantasma" size="chico" onClick={() => verResultados(c.id)}>
                  Ver cómo le fue
                </Button>
              </li>
            ))}
          </ul>
        )}
        {listado.truncado && (
          <p className="text-xs text-muted">
            Se muestran las más recientes. Hay más campañas de las que caben acá.
          </p>
        )}
      </div>

      {resultados && (
        <div className="flex flex-col gap-3 rounded-tarjeta border border-line bg-raised p-5">
          <h2 className="text-base font-bold text-ink">{resultados.campana.name}</h2>
          <p className="text-sm text-body">
            <span className="dato">{resultados.porEstado.queued ?? 0}</span> enviados ·{' '}
            <span className="dato">{resultados.porEstado.skipped ?? 0}</span> saltados ·{' '}
            <span className="dato">{resultados.porEstado.failed ?? 0}</span> con error
          </p>
          {resultados.motivos.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink">Por qué no le llegó a todos</span>
              <ul className="flex flex-col gap-1">
                {resultados.motivos.map((m) => (
                  <li key={m.motivo} className="text-sm text-body">
                    <span className="dato">{m.n}</span> {m.motivo}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-body">
            Costo estimado: <span className="dato">US$ {resultados.costoUsd.toFixed(2)}</span>
          </p>
        </div>
      )}
    </section>
  );
}
