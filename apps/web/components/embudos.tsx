'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AvisoResultado,
  Badge,
  Button,
  EncabezadoDePagina,
  Input,
  Skeleton,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, type PipelineDto, type StageDto } from '../lib/api';

/**
 * Embudos y etapas (#460).
 *
 * Renombrar el embudo, agregar una etapa, reordenarlas, cambiarles el
 * nombre o los días esperados y borrar una vacía: las cinco rutas existen
 * desde #35 y no las llamaba ninguna pantalla. El tablero de oportunidades
 * dibujaba las etapas sembradas y no había forma de tocarlas — un embudo
 * que no es el del negocio se usa igual, torcido, y después los números
 * dicen cualquier cosa.
 *
 * Borrar una etapa CON oportunidades se rechaza en el servidor a propósito:
 * moverlas —¿se ganaron?, ¿se perdieron?— es una decisión del negocio.
 */
const TIPO: Record<StageDto['type'], string> = {
  open: 'Abierta',
  won: 'Ganada',
  lost: 'Perdida',
};

export function Embudos() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [nueva, setNueva] = useState<Record<string, string>>({});

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const datos = await apiFetch<PipelineDto[]>(config, session, tenant, '/pipelines');
      setPipelines(datos);
      // Los campos editables arrancan con lo que hay: así "guardar" sin
      // tocar nada no borra el nombre.
      setNombres(Object.fromEntries(datos.flatMap((p) => [
        [p.id, p.name],
        ...p.stages.map((s) => [s.id, s.name] as const),
      ])));
      setAviso(null);
    } catch (err) {
      setAviso((err as Error).message);
      setPipelines([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function llamar(clave: string, path: string, init: RequestInit) {
    if (!session || !tenant || ocupado) return;
    setOcupado(clave);
    try {
      await apiFetch(config, session, tenant, path, init);
      setAviso(null);
      await cargar();
    } catch (err) {
      // El servidor explica por qué no se puede borrar una etapa con
      // oportunidades adentro; repetirlo acá sería que un día dejen de
      // coincidir.
      setAviso((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  /** Mueve una etapa abierta un lugar. El orden que viaja es el completo. */
  function mover(p: PipelineDto, stage: StageDto, delta: number) {
    const abiertas = p.stages.filter((s) => s.type === 'open');
    const i = abiertas.findIndex((s) => s.id === stage.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= abiertas.length) return;
    const orden = abiertas.map((s) => s.id);
    [orden[i], orden[j]] = [orden[j], orden[i]];
    void llamar(stage.id, `/pipelines/${p.id}/orden`, {
      method: 'PUT',
      body: JSON.stringify({ stageIds: orden }),
    });
  }

  async function agregar(e: FormEvent, p: PipelineDto) {
    e.preventDefault();
    const nombre = (nueva[p.id] ?? '').trim();
    if (!nombre) return;
    await llamar(`nueva-${p.id}`, `/pipelines/${p.id}/etapas`, {
      method: 'POST',
      body: JSON.stringify({ name: nombre }),
    });
    setNueva({ ...nueva, [p.id]: '' });
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  if (pipelines === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <EncabezadoDePagina
        rotulo="CONFIGURACIÓN"
        titulo="Embudos y etapas"
        apoyo="Por dónde pasa una oportunidad hasta cerrarse. Las etapas de acá son las columnas del tablero, así que conviene que se llamen como las llama tu equipo."
      />

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      {pipelines.map((p) => (
        <div key={p.id} className="flex flex-col gap-3 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void llamar(p.id, `/pipelines/${p.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: nombres[p.id] ?? p.name }),
              });
            }}
          >
            <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-ink">
              Nombre del embudo
              <Input
                value={nombres[p.id] ?? p.name}
                onChange={(e) => setNombres({ ...nombres, [p.id]: e.target.value })}
              />
            </label>
            <Button type="submit" variant="secundario" size="chico" disabled={ocupado === p.id}>
              {ocupado === p.id ? 'Guardando…' : 'Renombrar'}
            </Button>
          </form>

          <ul className="flex flex-col gap-2">
            {p.stages.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-campo border border-line bg-bg px-3 py-2">
                <Input
                  aria-label={`Nombre de la etapa ${s.name}`}
                  className="h-9 w-48 text-sm"
                  value={nombres[s.id] ?? s.name}
                  onChange={(e) => setNombres({ ...nombres, [s.id]: e.target.value })}
                />
                <Badge role={s.type === 'won' ? 'good' : s.type === 'lost' ? 'bad' : 'neutral'}>
                  {TIPO[s.type]}
                </Badge>
                {/* Ganada y perdida son el cierre: no se mueven ni se
                    borran, porque el tablero las necesita para saber qué
                    terminó bien y qué no. */}
                {s.type === 'open' && (
                  <>
                    <Button
                      variant="fantasma"
                      size="chico"
                      aria-label={`Subir ${s.name}`}
                      disabled={ocupado === s.id}
                      onClick={() => mover(p, s, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="fantasma"
                      size="chico"
                      aria-label={`Bajar ${s.name}`}
                      disabled={ocupado === s.id}
                      onClick={() => mover(p, s, 1)}
                    >
                      ↓
                    </Button>
                  </>
                )}
                <span className="ml-auto flex gap-2">
                  <Button
                    variant="secundario"
                    size="chico"
                    disabled={ocupado === s.id || (nombres[s.id] ?? s.name) === s.name}
                    onClick={() =>
                      void llamar(s.id, `/etapas/${s.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ name: nombres[s.id] ?? s.name }),
                      })
                    }
                  >
                    Guardar
                  </Button>
                  {s.type === 'open' && (
                    <Button
                      variant="fantasma"
                      size="chico"
                      disabled={ocupado === s.id}
                      onClick={() => void llamar(s.id, `/etapas/${s.id}`, { method: 'DELETE' })}
                    >
                      Borrar
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <form onSubmit={(e) => void agregar(e, p)} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-ink">
              Agregar una etapa
              <Input
                value={nueva[p.id] ?? ''}
                onChange={(e) => setNueva({ ...nueva, [p.id]: e.target.value })}
                placeholder="Visita agendada"
                className="w-56"
              />
            </label>
            <Button type="submit" size="chico" disabled={ocupado === `nueva-${p.id}`}>
              {ocupado === `nueva-${p.id}` ? 'Agregando…' : 'Agregar'}
            </Button>
            <span className="w-full text-xs text-muted">
              Entra antes del cierre: ganada y perdida siempre quedan al final.
            </span>
          </form>
        </div>
      ))}
    </section>
  );
}
