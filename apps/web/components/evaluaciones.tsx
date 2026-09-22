'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { AvisoResultado, Badge, Button, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

/**
 * Si el asistente mejoró o empeoró (#53, #447).
 *
 * El dataset y el juez existen desde #53, con un gate que impide pasar a
 * una configuración que rinde peor. Corría y no lo veía nadie: cambiar de
 * modelo o de prompt era a ciegas, y el gate bloqueaba sin que se pudiera
 * saber por qué.
 *
 * Lo que importa mostrar no es el número: es la COMPARACIÓN con la corrida
 * anterior y con qué configuración se sacó cada una. Un 0,82 suelto no
 * dice nada; «0,82 con Flash, antes 0,79 con Pro» decide.
 */
interface CorridaDto {
  id: string;
  provider: string;
  model: string;
  promptVersion: string | null;
  caseCount: number;
  casesMedidos: number;
  score: number;
  createdAt: string;
}

interface AgenteDto {
  id: string;
  name: string;
  provider: string;
  model: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function Diferencia({ corrida, previa }: { corrida: CorridaDto; previa?: CorridaDto }) {
  if (!previa) return <span className="text-micro text-muted">primera medición</span>;
  const delta = corrida.score - previa.score;
  // Cero no es "sin cambio" por casualidad: con pocos casos el promedio se
  // mueve poco, así que se muestra el número y no una flecha sola.
  const signo = delta > 0 ? '+' : '';
  return (
    <span className={`text-micro ${delta < 0 ? 'text-bad-text' : delta > 0 ? 'text-good-text' : 'text-muted'}`}>
      {signo}
      {Math.round(delta * 100)} puntos vs. la anterior
    </span>
  );
}

export function Evaluaciones() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [agente, setAgente] = useState<AgenteDto | null>(null);
  const [corridas, setCorridas] = useState<CorridaDto[] | null>(null);
  const [corriendo, setCorriendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const agentes = await apiFetch<AgenteDto[]>(config, session, tenant, '/agents');
      const primero = agentes[0] ?? null;
      setAgente(primero);
      setCorridas(
        primero
          ? await apiFetch<CorridaDto[]>(config, session, tenant, `/agents/${primero.id}/evals`)
          : [],
      );
    } catch {
      /* sin permiso para ver el consumo del asistente: la sección no aparece */
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || !agente || corridas === null) return null;

  const evaluar = async () => {
    if (!session) return;
    setAviso(null);
    setCorriendo(true);
    try {
      await apiFetch(config, session, tenant, `/agents/${agente.id}/evaluate`, { method: 'POST' });
      await cargar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos evaluar.');
    } finally {
      setCorriendo(false);
    }
  };

  const ultima = corridas[0];
  const configuracionActual = ultima && ultima.provider === agente.provider && ultima.model === agente.model;

  return (
    <section
      aria-label="Evaluaciones del asistente"
      className="pulso-panel rounded-tarjeta border border-line bg-raised p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical aria-hidden className="size-4 text-action-text" />
        <h2 className="font-display text-seccion font-bold text-ink">¿Mejoró o empeoró?</h2>
      </div>
      <p className="mt-1 max-w-prose text-dato text-body">
        Cada pulgar arriba o abajo de la bandeja se guarda como un caso. Correr la evaluación mide
        la configuración de hoy contra esos casos, y así un cambio de modelo o de prompt deja de
        ser a ciegas.
      </p>

      {corridas.length === 0 ? (
        <p className="mt-3 rounded-campo border border-line bg-rest px-4 py-3 text-dato text-body">
          Todavía no se ha medido nada. Los casos salen del pulgar arriba/abajo de la bandeja: con
          unos pocos ya sirve para comparar.
        </p>
      ) : (
        <>
          {/* La última corrida, grande: es la que responde la pregunta. */}
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-campo border border-line bg-bg p-4">
            <strong className="font-mono text-titulo text-ink">{pct(ultima.score)}</strong>
            <div className="flex flex-col">
              <Diferencia corrida={ultima} previa={corridas[1]} />
              <span className="text-micro text-muted">
                {ultima.casesMedidos} de {ultima.caseCount} casos medidos · {ultima.provider}/
                {ultima.model}
              </span>
            </div>
            {!configuracionActual && (
              // Si la última medición NO es de la configuración vigente, el
              // número no dice nada del asistente que está atendiendo ahora.
              <Badge role="warn">Medida con otra configuración</Badge>
            )}
          </div>

          <ul className="mt-3 flex flex-col gap-1">
            {corridas.slice(1, 6).map((c, i) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 border-t border-line pt-1 text-dato text-body"
              >
                <span className="font-mono text-ink">{pct(c.score)}</span>
                <span className="text-muted">
                  {c.provider}/{c.model}
                  {c.promptVersion ? ` · prompt ${c.promptVersion}` : ''}
                </span>
                <Diferencia corrida={c} previa={corridas[i + 2]} />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-4">
        <Button variant="secundario" onClick={() => void evaluar()} disabled={corriendo}>
          {corriendo ? 'Midiendo…' : 'Medir ahora'}
        </Button>
      </div>

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}
    </section>
  );
}
