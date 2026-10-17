'use client';

import { useEffect, useRef, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { AvisoResultado, Badge, Button, EstadoVacio, useSession } from '@iaxti/ui/react';
import { SelectorDeAsistente, useAsistenteElegido } from './selector-de-asistente';
import { apiFetch, avisoDe, type Aviso } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';

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
// Exportado para que `esqueletos-medidos.spec.ts` TIPE su simulacro: si
// este DTO cambia, la prueba deja de compilar en vez de seguir midiendo
// contra una forma que ya no existe.
export interface CorridaDto {
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
  if (!previa) return <span className="text-rotulo text-muted">primera medición</span>;
  const delta = corrida.score - previa.score;
  // Cero no es "sin cambio" por casualidad: con pocos casos el promedio se
  // mueve poco, así que se muestra el número y no una flecha sola.
  const signo = delta > 0 ? '+' : '';
  return (
    <span className={`text-rotulo ${delta < 0 ? 'text-bad-text' : delta > 0 ? 'text-good-text' : 'text-muted'}`}>
      {signo}
      {Math.round(delta * 100)} puntos vs. la anterior
    </span>
  );
}

export function Evaluaciones() {
  const { session } = useSession();
  const tenant = useSelectedTenant();
  // Ni el historial ni una medición en vuelo pertenecen a la próxima sesión.
  return session && tenant
    ? <EvaluacionesDelNegocio key={`${tenant}|${session.access_token}`} />
    : null;
}

function EvaluacionesDelNegocio() {
  // Las corridas son DEL asistente elegido, no del primero de la lista: dos
  // asistentes con modelos distintos tienen scores distintos, y mostrar los
  // de uno bajo el nombre del otro es peor que no mostrar nada (#494).
  const { tenant, asistentes, elegido: agente, elegir } = useAsistenteElegido<AgenteDto>();
  return <EvaluacionesDelAsistente key={agente?.id ?? 'cargando'}
    tenant={tenant} asistentes={asistentes} agente={agente} elegir={elegir} />;
}

function EvaluacionesDelAsistente({ tenant, asistentes, agente, elegir }: {
  tenant: string | null;
  asistentes: AgenteDto[] | null;
  agente: AgenteDto | null;
  elegir: (id: string) => void;
}) {
  const { config, session } = useSession();
  /**
   * La ruta en `null` mientras no haya asistente (#788).
   *
   * Acá vivía la versión a mano de este estado, y era la parte más delicada:
   * «no hay asistente» NO es «está cargando», y confundirlos dejaba el
   * esqueleto puesto PARA SIEMPRE —doce segundos en la prueba que mide los
   * altos, y en la pantalla, hasta que alguien se fuera—. La rama volvía antes
   * de pedir nada, así que el `finally` que apagaba `cargando` nunca corría.
   *
   * Con la ruta en `null` el hook contesta `nada-que-pedir` y el bug no se
   * puede escribir: no hay un `finally` del que acordarse.
   */
  const { carga, recargando, reintentar, reemplazar } = useCarga<CorridaDto[]>(
    agente ? `/agents/${agente.id}/evals` : null,
  );
  const [corriendo, setCorriendo] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const vigente = useRef(true);
  useEffect(() => {
    vigente.current = true;
    return () => { vigente.current = false; };
  }, []);

  const corridas = carga.estado === 'ok' ? carga.dato : null;

  // Dos corridas: 427 px medidos a 360, frente a 410 a 412 (#588).
  const marco = 'pulso-panel rounded-tarjeta border border-line bg-raised p-5 max-[399px]:min-h-[427px]';
  const titulo = 'Evaluaciones del asistente';

  // Dos llamadas en cascada —los asistentes y después SUS corridas—, así que
  // esta es la que más se notaba: el panel de Ajustes → IA no existía durante
  // las dos y después empujaba todo lo de abajo.
  if (!tenant) return null;
  // La lista de asistentes todavía en vuelo cuenta como cargando: es la
  // primera de las dos llamadas, y sin esto el panel desaparecería durante
  // ella para volver a aparecer un instante después.
  if (asistentes === null || carga.estado === 'cargando') {
    // 336 px MEDIDOS (el panel con dos corridas mide 410). A ojo: 168, la
    // mitad.
    return <PanelCargando etiqueta={titulo} className={marco} alto={336} filas={3} />;
  }
  // Sin asistente no hay evaluaciones de nadie, y eso no es un error.
  if (carga.estado === 'nada-que-pedir' || !agente) return null;
  if (carga.estado !== 'ok' || corridas === null) {
    // El 403 sigue sin dibujar nada —estaba escrito: «sin permiso para ver el
    // consumo del asistente, la sección no aparece»—, pero una caída ya no se
    // esconde detrás de esa decisión.
    return <AvisoDeCarga carga={carga} onReintentar={reintentar} />;
  }

  const evaluar = async () => {
    if (!session || corriendo) return;
    setAviso(null);
    setCorriendo(true);
    try {
      const corrida = await apiFetch<CorridaDto>(config, session, tenant, `/agents/${agente.id}/evaluate`, { method: 'POST' });
      // La API devuelve la corrida ya guardada. Un GET posterior podía fallar
      // y ocultar la medición pagada (#588); no hace falta volver a pedirla.
      if (vigente.current) reemplazar([corrida, ...corridas.filter((c) => c.id !== corrida.id)]);
    } catch (e) {
      if (vigente.current) setAviso(avisoDe(e));
    } finally {
      if (vigente.current) setCorriendo(false);
    }
  };

  const ultima = corridas[0];
  const configuracionActual = ultima && ultima.provider === agente.provider && ultima.model === agente.model;

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical aria-hidden className="size-4 text-action-text" />
        <h2 className="font-display text-seccion font-bold text-ink">¿Mejoró o empeoró?</h2>
        <span className="ml-auto">
          <SelectorDeAsistente asistentes={asistentes ?? []} elegidoId={agente.id} onElegir={elegir} />
        </span>
      </div>
      <p className="mt-1 max-w-prose text-dato text-body">
        Cada pulgar arriba o abajo de la bandeja se guarda como un caso. Correr la evaluación mide
        la configuración de hoy contra esos casos, y así un cambio de modelo o de prompt deja de
        ser a ciegas.
      </p>

      {corridas.length === 0 ? (
        <EstadoVacio compacto className="mt-3" titulo="Todavía no se ha medido nada"
          descripcion="Los casos salen del pulgar arriba/abajo de la bandeja: con unos pocos ya sirve para comparar."
          accion={{ etiqueta: corriendo ? 'Midiendo…' : 'Medir ahora', onClick: () => void evaluar() }} />
      ) : (
        <>
          {/* La última corrida, grande: es la que responde la pregunta. */}
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-campo border border-line bg-bg p-4">
            <strong className="font-mono text-titulo text-ink">{pct(ultima.score)}</strong>
            <div className="flex flex-col">
              <Diferencia corrida={ultima} previa={corridas[1]} />
              <span className="text-rotulo text-muted">
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

      {corridas.length > 0 && <div className="mt-4">
        <Button variant="secundario" onClick={() => void evaluar()} disabled={corriendo}>
          {corriendo ? 'Midiendo…' : 'Medir ahora'}
        </Button>
      </div>}

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso.texto}
          {aviso.rastro && <span className="mt-1 block font-mono text-rotulo">{aviso.rastro}</span>}
        </AvisoResultado>
      )}
    </section>
  );
}
