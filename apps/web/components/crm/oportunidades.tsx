'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';
import { FichaOportunidad } from './ficha-oportunidad';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { Badge, Button, DataTable, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EstadoVacio, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Tabs, TabsList, TabsTrigger, type ColumnDef, type RowSelectionState, type SortingState, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import {
  apiFetch,
  fmtClp,
  type DealCardDto,
  type LossReasonDto,
  type PipelineDto,
  type EmbudoDto,
  type SavedFilterDto,
  type StageDto,
  mensajeDeError,
} from '../../lib/api';

import { crmClient } from '@iaxti/sdk';
import { EtiquetarSeleccion } from './etiquetar-seleccion';

// Oportunidades (#33, SPEC §10/§29): tablero Kanban por pipeline con
// arrastre (motivo al retroceder, lista de motivos al perder) y lista con
// filtros guardados por usuario. Cursor SIEMPRE; a 360 px las columnas
// se deslizan. "Estancada" es texto, no solo color (§29).

interface Columna {
  items: DealCardDto[];
  cursor: string | null;
  cargando: boolean;
}

interface MovimientoPendiente {
  deal: DealCardDto;
  desde: StageDto;
  hasta: StageDto;
}

/**
 * Lo que la tarjeta MUESTRA. Va aparte del arrastre porque el `DragOverlay`
 * necesita el mismo cuerpo SIN oyentes: si la tarjeta que flota arrastrara a
 * su vez, soltarla encima de sí misma no tendría sentido.
 */
function CuerpoTarjeta({ deal }: { deal: DealCardDto }) {
  return (
    <>
      {/* Dos líneas y no tres (#1155): el monto sube al lado del título. Con
          tres, una tarjeta medía 105 px y en una ventana de 900 entraban seis;
          el tablero es justamente la pantalla donde querés ver muchas de una.
          El monto queda a la derecha y en mono, que es donde el ojo lo busca
          cuando baja por una columna. */}
      <p className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-ink">{deal.title}</span>
        <span className="dato shrink-0 text-xs text-ink">
          {deal.currency === 'UF' && deal.value !== null ? `UF ${deal.value}` : fmtClp(deal.valueClp)}
        </span>
      </p>
      <p className="mt-1 flex items-center justify-between gap-2">
        <span className="truncate text-xs text-action-text">
          {deal.contactName ?? deal.contactPhone}
        </span>
        <QueHayQueHacer deal={deal} />
      </p>
    </>
  );
}

/**
 * La tarjeta arrastrable (#1367).
 *
 * El arrastre HTML5 nativo que había (#33) solo existía para el ratón: los
 * eventos `dragstart`/`drop` no se disparan con un dedo, así que en el
 * celular —desde donde se entra al tablero por diseño— mover una
 * oportunidad era imposible, y sin foco en la tarjeta tampoco había
 * teclado. dnd-kit trae el tactil y el teclado con MENOS código que el
 * `dataTransfer` a mano (ADR-0035).
 *
 * Toda la tarjeta sigue abriendo la ficha con un clic, y el sensor de
 * puntero pide 6 px de recorrido antes de arrastrar: un clic no se mueve,
 * así que las dos cosas conviven sin que una le robe la otra al usuario.
 */
function TarjetaDeal({
  deal,
  onAbrir,
  abierta,
}: {
  deal: DealCardDto;
  onAbrir: () => void;
  abierta: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id });
  return (
    <article
      ref={setNodeRef}
      {...attributes}
      /* dnd-kit etiqueta la tarjeta como `button`, pero el título ADENTRO es
         un botón y el contacto un enlace: un botón dentro de otro botón no
         es HTML válido y el lector de pantalla lo anuncia dos veces. Sin el
         rol queda un elemento enfocable y arrastrable —el `tabIndex` y el
         `aria-roledescription` los pone `attributes`— sin duplicar la
         interacción. */
      role={undefined}
      {...listeners}
      /* El TÍTULO es un botón de verdad y el enlace del contacto lleva a
         otra pantalla: ninguno de los dos puede empezar un arrastre. */
      onClick={onAbrir}
      className={`cursor-grab rounded-campo border bg-bg p-3 active:cursor-grabbing ${
        abierta ? 'border-action' : 'border-line hover:border-line-strong'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <p className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onAbrir();
          }}
          className="truncate text-left text-sm font-medium text-ink"
        >
          {deal.title}
        </button>
        <span className="dato shrink-0 text-xs text-ink">
          {deal.currency === 'UF' && deal.value !== null ? `UF ${deal.value}` : fmtClp(deal.valueClp)}
        </span>
      </p>
      <p className="mt-1 flex items-center justify-between gap-2">
        {/* Para en seco la propagación: este enlace lleva a OTRA pantalla, y
            abrir la ficha al mismo tiempo dejaría un panel que nadie pidió
            sobre una página que ya cambió. */}
        <a
          href={`/contactos/${deal.contactId}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="truncate text-xs text-action-text"
        >
          {deal.contactName ?? deal.contactPhone}
        </a>
        <QueHayQueHacer deal={deal} />
      </p>
    </article>
  );
}

/**
 * Lo próximo que hay que hacer con esta oportunidad (#1302).
 *
 * Esto es lo que separa un tablero que se LEE de uno con el que se TRABAJA, y
 * era la queja del dueño: «las tarjetas dicen poco», «no se puede trabajar
 * desde ahí». El dato estaba en `activities` desde la migración 0003 y no lo
 * leía nadie.
 *
 * ## Una sola ranura, y por qué
 *
 * #1155 midió que una tercera línea sube la tarjeta a 105 px y deja seis por
 * ventana de 900: el tablero es justamente la pantalla donde querés ver
 * muchas de una. Así que esto comparte la segunda línea con el contacto, que
 * trunca.
 *
 * Eso obliga a elegir cuando hay dos cosas que decir —atrasada Y estancada—,
 * y se elige la accionable: «atrasada» nombra algo que alguien dejó pasar
 * ayer; «estancada» nombra que hace rato que no se mueve. Lo que la ranura
 * no alcanza a mostrar va entero en la ficha de la oportunidad (#1301).
 *
 * ## Texto, no solo color
 *
 * SPEC §29 lo pide para «Estancada» y vale igual acá: el color no puede ser
 * el único portador de significado. Cada estado dice su palabra.
 *
 * ## El estado viene calculado del servidor
 *
 * `estado` y `dias` NO se calculan acá. El navegador no conoce
 * `tenants.timezone` —está medido en `lib/reportes.ts`— así que no puede
 * contestar «¿vence hoy?» sin inventarse una zona, y entre las 21:00 y la
 * medianoche chilenas UTC ya es mañana: una tarea de hoy se vería atrasada
 * todas las noches.
 */
export function QueHayQueHacer({ deal }: { deal: DealCardDto }) {
  // Una cerrada no tiene «próximo paso»: lo que le quedara pendiente dejó de
  // ser una pendiente el día que se ganó o se perdió.
  if (deal.status !== 'open') return null;

  const prox = deal.proximaActividad;
  if (prox?.estado === 'atrasada') {
    return (
      <Badge role="bad">
        Atrasada {prox.dias} {prox.dias === 1 ? 'día' : 'días'}
      </Badge>
    );
  }
  if (prox?.estado === 'hoy') return <Badge role="warn">Vence hoy</Badge>;
  if (deal.stalled) return <Badge role="warn">Estancada</Badge>;
  if (prox?.estado === 'proxima') {
    return (
      <span className="shrink-0 text-xs text-muted">
        En <span className="dato">{prox.dias}</span> {prox.dias === 1 ? 'día' : 'días'}
      </span>
    );
  }
  if (prox?.estado === 'sin_fecha') {
    return <span className="shrink-0 text-xs text-muted">Sin fecha</span>;
  }
  /* Sin nada agendado: el estado más común al empezar y el que más importa.
     Es la tarjeta de la que nadie se está haciendo cargo, y es literalmente
     lo que el tablero no sabía decir. En apagado y no en etiqueta: si el
     negocio recién arranca lo dirían todas, y una pantalla entera de
     etiquetas no señala nada. */
  return <span className="shrink-0 text-xs text-muted">Sin agendar</span>;
}

/**
 * Sobre cuántas está midiendo el embudo (#1303).
 *
 * Una sola frase, y es la que las cabeceras no pueden decir solas: que las
 * pérdidas de cada columna se cuentan sobre TODO el historial y no sobre lo
 * que hay en pantalla. Sin eso, el «de 30» de la cabecera se confunde con el
 * conteo de la columna, que está tres líneas más arriba y dice otra cosa.
 *
 * ## Lo que esta frase decía de más
 *
 * Decía también en qué etapa se cae más —«Se cae más en Nuevo: 3 perdidas»—
 * y era repetir lo que la cabecera de esa misma columna ya muestra. Con un
 * solo embudo abierto es literalmente la misma frase dos veces en la misma
 * pantalla; con varios, es el mismo dato que el lector tiene delante.
 *
 * Lo cazó el techo de prosa (#1157): la pantalla llegó a 26 palabras con un
 * techo de 16. La guarda tenía razón por el motivo correcto — no era que
 * sobrara texto, era que sobraba un dato repetido.
 *
 * Se calla entera sin oportunidades: sin datos no hay embudo, y una línea
 * que diga «sobre 0» es ruido que ocupa alto.
 */
/**
 * Las cifras de arriba del tablero (Mesón, #1346).
 *
 * El prototipo traía tres; acá van las dos que el producto SABE: lo que está
 * en juego —la suma de las etapas abiertas, con su barra en el mismo orden que
 * las columnas— y lo ganado. Salen de `/deals/resumen`, el mismo que pone el
 * dinero en cada cabecera, y sin resumen no se dibujan: una cifra que miente es
 * peor que ninguna. «Cerró el asistente solo» y «vs el mes anterior» no se
 * muestran porque ese dato no existe todavía.
 *
 * El azul va en la etapa abierta más avanzada —la que está por cerrarse—; las
 * demás en grises del marco. Pocas palabras: la pantalla tiene techo de prosa.
 */
/** Lo de `GET /deals/resumen` → `ganado`: mes y día ya vienen en la zona del negocio. */
interface GanadoDelMes {
  esteMesClp: number;
  mesAnteriorClp: number;
  mes: number;
  dia: number;
  mesAnteriorCompleto: boolean;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * «Ganado» es el del MES contra el mes anterior cortado en el mismo día
 * (#1346). Antes sumaba todo lo ganado alguna vez: una cifra que solo crece
 * no dice cómo vas. Se muestran los dos montos y no un porcentaje: contra un
 * mes anterior en cero, «+∞ %» sería una métrica inventada.
 */
export function comparacionDelMes(g: GanadoDelMes): { titulo: string; contra: string } {
  const anterior = MESES[(g.mes + 10) % 12]!;
  const Anterior = anterior[0]!.toUpperCase() + anterior.slice(1);
  return {
    titulo: `Ganado en ${MESES[g.mes - 1]}`,
    contra: g.mesAnteriorCompleto ? `${Anterior} completo` : `${Anterior}, del 1 al ${g.dia}`,
  };
}

function CifrasDelEmbudo({
  etapas,
  resumen,
  ganadoMes,
}: {
  etapas: StageDto[];
  resumen: Record<string, { cuantas: number; totalClp: number }>;
  ganadoMes: GanadoDelMes | null;
}) {
  const abiertas = etapas.filter((e) => e.type === 'open' && resumen[e.id]);
  const ganadas = etapas.filter((e) => e.type === 'won' && resumen[e.id]);
  const enJuego = abiertas.reduce((s, e) => s + resumen[e.id].totalClp, 0);
  const ganado = ganadas.reduce((s, e) => s + resumen[e.id].totalClp, 0);
  const hayMes = ganadoMes !== null && (ganadoMes.esteMesClp > 0 || ganadoMes.mesAnteriorClp > 0);
  if (enJuego === 0 && ganado === 0 && !hayMes) return null;
  const ultimaConDinero = [...abiertas].reverse().find((e) => resumen[e.id].totalClp > 0)?.id;
  // Tres grises del marco, de claro a hondo; el azul lo lleva una sola.
  const tonos = ['bg-line', 'bg-line-strong', 'bg-faint'];
  return (
    // Solo desde 640 px: en el celular el tablero necesita el alto
    // (el-embudo-en-el-tablero pide > 400 px) y cada cabecera ya trae su total.
    <div className="hidden shrink-0 gap-3 px-6 pb-4 sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <section aria-label="En juego" className="rounded-tarjeta border border-line bg-raised p-4">
        <p className="text-dato text-muted">En juego</p>
        <p className="mt-2 font-mono text-titulo leading-none tabular-nums text-ink">{fmtClp(enJuego)}</p>
        {enJuego > 0 && (
          <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded" aria-hidden>
            {abiertas.filter((e) => resumen[e.id].totalClp > 0).map((e, i) => (
              <span
                key={e.id}
                title={`${e.name}: ${fmtClp(resumen[e.id].totalClp)}`}
                style={{ flexGrow: resumen[e.id].totalClp }}
                className={e.id === ultimaConDinero ? 'bg-action' : tonos[i % tonos.length]}
              />
            ))}
          </div>
        )}
      </section>
      {ganadoMes ? (
        <section aria-label="Ganado" className="rounded-tarjeta border border-line bg-raised p-4">
          <p className="text-dato text-muted">{comparacionDelMes(ganadoMes).titulo}</p>
          <p className="mt-2 font-mono text-titulo leading-none tabular-nums text-good-text">{fmtClp(ganadoMes.esteMesClp)}</p>
          <p className="mt-3 text-dato text-muted">
            {comparacionDelMes(ganadoMes).contra}: <span className="font-mono tabular-nums text-body">{fmtClp(ganadoMes.mesAnteriorClp)}</span>
          </p>
        </section>
      ) : (
        // Sin la cifra del mes (API vieja o error), lo que sí se sabe: el
        // total de las etapas ganadas. Nunca un número inventado en su lugar.
        <section aria-label="Ganado" className="rounded-tarjeta border border-line bg-raised p-4">
          <p className="text-dato text-muted">Ganado</p>
          <p className="mt-2 font-mono text-titulo leading-none tabular-nums text-good-text">{fmtClp(ganado)}</p>
        </section>
      )}
    </div>
  );
}

function LecturaDelEmbudo({ embudo }: { embudo: EmbudoDto | null }) {
  if (!embudo || embudo.oportunidades === 0) return null;
  return (
    <p className="shrink-0 px-6 pb-3 text-xs text-muted">
      Sobre <span className="dato">{embudo.oportunidades}</span>, desde que empezaste.
    </p>
  );
}

/**
 * Cuántas se pierden EN esta etapa (#1303).
 *
 * La queja era «no se entiende el embudo». Un tablero contesta «qué hay
 * ahora»; un embudo contesta «por dónde se cae la gente». Son preguntas
 * distintas, y la segunda no se puede deducir mirando las columnas: una etapa
 * con 30 y la siguiente con 0 se ve igual en un embudo que no convierte y en
 * uno que recién arrancó.
 *
 * El dato viene de `GET /pipelines/:id/embudo` (#695), que lo mide del
 * historial real (`deal_stage_history`) y no dividiendo el conteo de una
 * columna por el de la anterior, que es la versión falsa.
 *
 * ## Por qué las PÉRDIDAS y no la conversión
 *
 * Dos motivos, y conviene separarlos porque uno ya caducó.
 *
 * El que lo destapó: al poner la conversión acá se vio que estaba rota
 * —`avanzaron` contaba las perdidas como avanzadas, porque «Perdido» está
 * después de «Ganado» por posición, y un embudo donde se pierde todo marcaba
 * 100 %—. Eso **ya está arreglado** (#1310), así que no es el motivo por el
 * que esta cabecera sigue mostrando pérdidas. Queda escrito para que nadie
 * lo busque y no lo encuentre.
 *
 * El motivo que se mantiene:
 *
 *  - **Un conteo se lee sin traducir y un porcentaje con volúmenes chicos
 *    miente por omisión.** La primera versión de esta cabecera decía «0 %
 *    avanzó desde acá» sobre 30 oportunidades creadas el mismo día: cierto y
 *    engañoso, porque se lee «tu embudo no convierte» cuando dice «recién
 *    empezaste». Un negocio que arranca es exactamente el caso de IAxTi.
 *  - **Las pérdidas son la pregunta.** Lo que se pidió fue entender por
 *    dónde se cae la gente, no cuánto convierte cada etapa. La conversión
 *    completa, con su ciclo de venta y su comparación entre períodos, está
 *    en Reportes, que es donde se mira una vez por semana.
 *
 * Sin pérdidas no dice nada: una etapa por la que no se cae nadie no necesita
 * una línea que lo repita en cada columna, y en el tablero el alto es lo caro.
 * Solo en etapas ABIERTAS: «cuántas se pierden en Ganado» no es una pregunta.
 */
function DondeSePierde({ etapa }: { etapa: EmbudoDto['etapas'][number] | undefined }) {
  if (!etapa || etapa.type !== 'open' || etapa.perdidas === 0) return null;
  return (
    <p className="mt-0.5 text-xs text-muted">
      <span className="dato">{etapa.perdidas}</span> de <span className="dato">{etapa.entraron}</span>{' '}
      {etapa.perdidas === 1 ? 'se perdió acá' : 'se perdieron acá'}
    </p>
  );
}

/**
 * Una columna del tablero, que es también la zona de suelta de su etapa
 * (#1367).
 *
 * Mientras una tarjeta flota encima, la columna se marca con el azul: es la
 * señal de «acá cae» que el arrastre HTML5 no daba y que el dedo necesita
 * todavía más, porque no arrastra un cursor visible al lado.
 */
function ColumnaEtapa({
  stage,
  col,
  total,
  etapa,
  abierta,
  onAbrir,
  onCargarMas,
}: {
  stage: StageDto;
  col: Columna | undefined;
  total: { cuantas: number; totalClp: number } | undefined;
  etapa: EmbudoDto['etapas'][number] | undefined;
  abierta: string | null;
  onAbrir: (id: string) => void;
  onCargarMas: (cursor: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <section
      ref={setNodeRef}
      aria-label={`Etapa ${stage.name}`}
      className="relative flex min-w-72 max-w-[30rem] grow basis-72 snap-start flex-col pulso-panel rounded-tarjeta border bg-raised border-line"
    >
      {/* La señal de «acá cae» va en un anillo hijo y no en el borde de la
          sección: `pulso-panel` pinta su `border-color` fuera de las capas de
          Tailwind y cualquier utilidad de borde del section pierde la cascada
          — el azul quedaba en el DOM y el borde seguía gris (cazado en la
          captura del arrastre). El anillo no lleva `pulso-panel`, pinta
          encima con el mismo radio y 1 px, y va con `pointer-events-none`
          para no comerse el gesto: el patrón de la bandeja de adjuntos. */}
      {isOver && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-tarjeta border border-action"
        />
      )}
      {/* La cabecera no scrollea con las tarjetas: `shrink-0` acá y
          el `overflow-y` en el cuerpo. */}
      <header className="shrink-0 border-b border-line px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="truncate text-sm font-semibold text-ink">{stage.name}</h2>
          <span className="dato shrink-0 text-muted">{total?.cuantas ?? col?.items.length ?? 0}</span>
        </div>
        {/* El dinero de la etapa, no el de lo cargado. Sin resumen no
            se muestra nada: un total que miente es peor que ninguno,
            porque nadie lo contrasta. */}
        {total && total.cuantas > 0 && (
          <p className="dato mt-0.5 text-xs text-body">{fmtClp(total.totalClp)}</p>
        )}
        <DondeSePierde etapa={etapa} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {col?.cargando && !col.items.length ? (
          <Skeleton className="h-20" />
        ) : col && !col.items.length ? (
          /* Una etapa vacía es una columna de alto completo, porque
             sigue siendo el destino de un arrastre. Lo que no puede
             ser es un tubo gris sin una palabra: dice qué la llena. */
          <p className="m-auto rounded-campo border border-dashed border-line px-3 py-2 text-center text-xs text-muted">
            Arrastra una oportunidad acá
          </p>
        ) : (
          col?.items.map((deal) => (
            <TarjetaDeal key={deal.id} deal={deal} abierta={abierta === deal.id} onAbrir={() => onAbrir(deal.id)} />
          ))
        )}
        {col?.cursor && (
          <Button variant="fantasma" size="chico" onClick={() => onCargarMas(col.cursor!)}>
            Cargar más
          </Button>
        )}
      </div>
    </section>
  );
}

// Radix no admite `value=""` en un item: la cadena vacía es su "sin
// selección". Los filtros "todas" y "según mi visibilidad" son opciones
// elegibles, así que van con centinela y se traducen al salir.
const TODAS = '__todas__';
const VISIBILIDAD = '__visibilidad__';

/**
 * El salto del arrastre con teclado (#1367): una columna por pulsación.
 *
 * El que trae dnd-kit mueve 25 px, que con columnas de casi 300 son doce
 * pulsaciones para cruzar una: un teclado que exige insistir no es un
 * teclado. Un salto de columna entera hace que cada flecha diga «la de al
 * lado», que es lo que una persona se proponía al apretarla.
 */
const saltoTeclado: KeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  const SALTO = 280;
  switch (event.code) {
    case 'ArrowRight': return { ...currentCoordinates, x: currentCoordinates.x + SALTO };
    case 'ArrowLeft': return { ...currentCoordinates, x: currentCoordinates.x - SALTO };
    case 'ArrowUp': return { ...currentCoordinates, y: currentCoordinates.y - SALTO };
    case 'ArrowDown': return { ...currentCoordinates, y: currentCoordinates.y + SALTO };
  }
  return undefined;
};

export function Oportunidades() {
  const tenant = useSelectedTenant();
  return tenant
    ? <OportunidadesDelNegocio key={tenant} tenant={tenant} />
    : <p className="p-6 text-muted">Elige un negocio en el selector.</p>;
}

function OportunidadesDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const client = useMemo(() => session ? crmClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created', desc: true }]);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [listaActual, setListaActual] = useState<string>();
  const [historialLista, setHistorialLista] = useState<Array<string | undefined>>([]);
  const [cargandoLista, setCargandoLista] = useState(false);
  const serialLista = useRef(0);
  function primeraLista() { setListaActual(undefined); setHistorialLista([]); setSelection({}); }
  const [pipelines, setPipelines] = useState<PipelineDto[] | null>(null);
  const [pipelineId, setPipelineId] = useState<string>('');
  const [vista, setVista] = useState<'tablero' | 'lista'>('tablero');
  const [columnas, setColumnas] = useState<Record<string, Columna>>({});
  const [motivos, setMotivos] = useState<LossReasonDto[]>([]);
  const [pendiente, setPendiente] = useState<MovimientoPendiente | null>(null);
  /** La tarjeta que flota, para el `DragOverlay` (#1367). */
  const [arrastrando, setArrastrando] = useState<DealCardDto | null>(null);
  /**
   * Se mueve cada vez que una oportunidad cambia de etapa. La ficha vive con
   * `key={dealId}`; sin esto seguía mostrando la etapa VIEJA después de
   * moverla — arrastrada o movida desde su selector — hasta que alguien la
   * cerrara y la abriera de nuevo.
   */
  const [version, setVersion] = useState(0);
  /** Qué oportunidad está abierta en la ficha de al lado (#1301). */
  const [abierta, setAbierta] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [motivoPerdidaId, setMotivoPerdidaId] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  // Cuántas y cuánto hay DE VERDAD en cada etapa (#1155). Las columnas traen
  // veinte, así que su `items.length` no es el conteo de la etapa y su suma no
  // es el dinero de la etapa. Viene del servidor en una consulta para todo el
  // tablero.
  const [resumen, setResumen] = useState<Record<string, { cuantas: number; totalClp: number }>>({});
  const [ganadoMes, setGanadoMes] = useState<GanadoDelMes | null>(null);
  /**
   * El embudo leído, en el tablero (#1303).
   *
   * La medición ya existía (#695) y se dibujaba SOLO dentro de Reportes, que
   * se vende con el plan Equipo. El endpoint, en cambio, es de `crm` y pide
   * `crm.deals.read`: el mismo módulo y el mismo permiso que este tablero.
   * O sea que quien mira estas columnas ya tenía derecho a esta lectura y no
   * tenía dónde verla. Lo que se vende con el plan es la PANTALLA de
   * reportes, no el dato.
   *
   * Sin `from` ni `to` a propósito: el endpoint toma entonces todo el
   * historial, y el tablero no tiene que calcular «hace 90 días» en el
   * navegador —que no conoce la zona del negocio y de noche se corre un día—.
   * El alcance se dice en pantalla con todas sus letras.
   *
   * `null` es «no se pudo» y se calla; no se inventa un 0 %.
   */
  const [embudo, setEmbudo] = useState<EmbudoDto | null>(null);

  // Lista
  const [lista, setLista] = useState<DealCardDto[]>([]);
  const [listaCursor, setListaCursor] = useState<string | null>(null);
  const [filtros, guardarFiltros] = useState<Record<string, string>>({});
  const [guardados, setGuardados] = useState<SavedFilterDto[]>([]);
  const [nombreFiltro, setNombreFiltro] = useState('');

  function setFiltros(nuevos: Record<string, string>) { guardarFiltros(nuevos); primeraLista(); }

  const api = useCallback(
    <T,>(path: string, init?: RequestInit) => {
      if (!session || !tenant) return Promise.reject(new Error('sin sesión'));
      return apiFetch<T>(config, session, tenant, path, init);
    },
    [config, session, tenant],
  );

  useEffect(() => {
    if (!session || !tenant) return;
    void api<PipelineDto[]>('/pipelines').then((p) => {
      setPipelines(p);
      setPipelineId((actual) => actual || p[0]?.id || '');
    }).catch((err) => setAviso(mensajeDeError(err)));
    void api<LossReasonDto[]>('/loss-reasons').then(setMotivos).catch(() => setMotivos([]));
    void api<SavedFilterDto[]>('/saved-filters').then(setGuardados).catch(() => setGuardados([]));
  }, [api, session, tenant]);

  const pipeline = pipelines?.find((p) => p.id === pipelineId) ?? null;
  /** Todas las tarjetas cargadas, para resolver un id al soltar o anunciar. */
  const todas = useMemo(() => Object.values(columnas).flatMap((c) => c.items), [columnas]);
  const etapaDe = useCallback(
    (id: string | number | undefined) => pipeline?.stages.find((s) => s.id === id),
    [pipeline],
  );
  const sensores = useSensors(
    // 6 px de recorrido antes de arrastrar: un clic no se mueve, así que abrir
    // la ficha y arrastrar no se pisan (#1367).
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: saltoTeclado }),
  );
  /** Lo que oye quien usa lector de pantalla, en la voz del producto. */
  const anuncios: Announcements = {
    onDragStart: ({ active }) => `Tomaste ${todas.find((d) => d.id === active.id)?.title ?? 'una oportunidad'}`,
    onDragOver: ({ over }) => (over ? `Sobre ${etapaDe(over.id)?.name ?? 'otra etapa'}` : undefined),
    onDragEnd: ({ over }) => (over ? `Soltada en ${etapaDe(over.id)?.name ?? 'otra etapa'}` : undefined),
    onDragCancel: () => 'La devolviste a su etapa',
  };

  const cargarColumna = useCallback(
    async (stage: StageDto, cursor?: string) => {
      setColumnas((prev) => ({
        ...prev,
        [stage.id]: { items: cursor ? prev[stage.id]?.items ?? [] : [], cursor: null, cargando: true },
      }));
      try {
        const res = await api<{ items: DealCardDto[]; nextCursor: string | null }>(
          `/deals?pipelineId=${pipelineId}&stageId=${stage.id}&limit=20${cursor ? `&cursor=${cursor}` : ''}`,
        );
        setColumnas((prev) => ({
          ...prev,
          [stage.id]: {
            items: cursor ? [...(prev[stage.id]?.items ?? []), ...res.items] : res.items,
            cursor: res.nextCursor,
            cargando: false,
          },
        }));
      } catch (err) {
        setAviso(mensajeDeError(err));
      }
    },
    [api, pipelineId],
  );

  const cargarResumen = useCallback(async () => {
    if (!pipelineId) return;
    try {
      const res = await api<{ items: { stageId: string; cuantas: number; totalClp: number }[]; ganado?: GanadoDelMes }>(
        `/deals/resumen?pipelineId=${pipelineId}`,
      );
      setResumen(Object.fromEntries(res.items.map((f) => [f.stageId, { cuantas: f.cuantas, totalClp: f.totalClp }])));
      setGanadoMes(res.ganado ?? null);
    } catch {
      // El tablero funciona sin los totales: lo que no se puede es mostrar un
      // número inventado en su lugar. Sin resumen, la cabecera muestra lo que
      // tiene cargado y lo dice.
      setResumen({});
      setGanadoMes(null);
    }
  }, [api, pipelineId]);

  const cargarEmbudo = useCallback(async () => {
    if (!pipelineId) return;
    try {
      setEmbudo(await api<EmbudoDto>(`/pipelines/${pipelineId}/embudo`));
    } catch {
      // Degrada en silencio: el tablero es para trabajar y la lectura del
      // embudo es un extra. Un aviso rojo arriba por algo que nadie pidió
      // sería peor que no mostrarlo.
      setEmbudo(null);
    }
  }, [api, pipelineId]);

  useEffect(() => {
    if (!pipeline) return;
    for (const stage of pipeline.stages) void cargarColumna(stage);
    void cargarResumen();
    void cargarEmbudo();
  }, [pipeline, cargarColumna, cargarResumen, cargarEmbudo]);

  const cargarLista = useCallback(async () => {
    if (!client) return;
    const request = ++serialLista.current;
    setCargandoLista(true); setAviso(null);
    const query = new URLSearchParams({ pipelineId, limit: '25', sort: sorting[0].id, order: sorting[0].desc ? 'desc' : 'asc' });
    for (const [k, v] of Object.entries(filtros)) if (v) query.set(k, v);
    if (listaActual) query.set('cursor', listaActual);
    try {
      const res = await client.deals<DealCardDto>(query);
      if (request === serialLista.current) { setLista(res.items); setListaCursor(res.nextCursor); }
    } catch (err) { if (request === serialLista.current) setAviso(mensajeDeError(err)); }
    finally { if (request === serialLista.current) setCargandoLista(false); }
  }, [client, pipelineId, filtros, sorting, listaActual]);

  useEffect(() => {
    if (vista === 'lista' && pipelineId && session && tenant) void cargarLista();
    return () => { serialLista.current++; };
  }, [vista, pipelineId, cargarLista, session, tenant]);

  const columnasLista: ColumnDef<DealCardDto, unknown>[] = [
    { id: 'title', accessorKey: 'title', header: 'Oportunidad', enableHiding: false, cell: ({ row }) => <div>
      <a href={`/contactos/${row.original.contactId}`} className="block min-h-control text-action-text"><span className="block font-medium text-ink">{row.original.title}</span><span>{row.original.contactName ?? row.original.contactPhone ?? 'Ver contacto'}</span></a>
      {row.original.stalled && row.original.status === 'open' && <Badge role="warn">Estancada</Badge>}
      <span className="block font-mono sm:hidden">{fmtClp(row.original.valueClp)}</span>
    </div> },
    { id: 'stage', accessorKey: 'stageName', header: 'Etapa' },
    { id: 'value', accessorKey: 'valueClp', header: 'Monto CLP', cell: ({ row }) => <span className="font-mono">{fmtClp(row.original.valueClp)}{row.original.currency === 'UF' && row.original.value !== null && <span className="block text-muted">UF {row.original.value}</span>}</span> },
    { id: 'created', header: 'Creada', accessorKey: 'createdAt', cell: ({ row }) => <time className="font-mono" dateTime={row.original.createdAt}>{new Date(row.original.createdAt).toLocaleDateString('es-CL')}</time> },
  ];

  async function ejecutarMovimiento(deal: DealCardDto, hasta: StageDto, extra: Record<string, string> = {}) {
    setAviso(null);
    try {
      await api(`/deals/${deal.id}/stage`, {
        method: 'POST',
        body: JSON.stringify({ stageId: hasta.id, ...extra }),
      });
      setVersion((v) => v + 1);
      const desde = pipeline?.stages.find((s) => s.id === deal.stageId);
      if (desde) void cargarColumna(desde);
      void cargarColumna(hasta);
      void cargarResumen();
    } catch (err) {
      setAviso(mensajeDeError(err));
    }
  }

  /**
   * El momento de la decisión de un movimiento, sin evento de por medio
   * (#1367): la da el arrastre o el selector de la ficha, que llegan con la
   * misma pareja (oportunidad, etapa de destino).
   */
  function soltar(deal: DealCardDto, hasta: StageDto) {
    const desde = pipeline?.stages.find((s) => s.id === deal.stageId);
    if (!desde || desde.id === hasta.id) return;
    // Retroceder pide motivo; cerrar en perdido pide motivo de la lista (§10).
    if (hasta.type === 'lost' || (hasta.type === 'open' && hasta.position < desde.position)) {
      setMotivo('');
      setMotivoPerdidaId(motivos[0]?.id ?? '');
      setPendiente({ deal, desde, hasta });
      return;
    }
    void ejecutarMovimiento(deal, hasta);
  }

  function alSoltar({ active, over }: DragEndEvent) {
    setArrastrando(null);
    const hasta = over ? etapaDe(over.id) : undefined;
    const deal = todas.find((d) => d.id === active.id);
    if (!hasta || !deal) return;
    soltar(deal, hasta);
  }

  if (!tenant) return <p className="p-6 text-muted">Elige un negocio en el selector.</p>;
  if (!pipelines) {
    return <div className="flex gap-4 p-6"><Skeleton className="h-64 w-72" /><Skeleton className="h-64 w-72" /></div>;
  }
  if (!pipeline) {
    return (
      <EstadoVacio className="m-6" titulo="Prepara las etapas de tus ventas"
        descripcion="Aquí verás tus oportunidades, ordenadas por etapa. Configura el negocio para crear el primer embudo."
        accion={{ etiqueta: 'Configurar mi negocio', href: '/ajustes/ia' }}
        pideleAIAxTi="Arma el embudo de mis ventas con las etapas que uso" />
    );
  }

  return (
    /* La pantalla NO scrollea: el alto lo fija la ventana (`sinMargen` en la
       página) y adentro scrollea cada columna. Así la cabecera de la etapa
       sigue a la vista mientras mirás sus tarjetas, que es la mitad de para
       qué sirve un tablero (#1155).

       Y el tablero y la ficha son hermanos en una fila (#1301): la ficha se
       lleva su ancho y las columnas se comprimen, en vez de taparlas. Mirar
       una oportunidad sin perder de vista en qué etapa estaba es justamente
       para lo que sirve un panel y no una página. */
    <div className="flex h-full min-h-0">
    {/* `min-w-0` y no solo `flex-1`: un hijo de flex no baja de su ancho de
        contenido salvo que se le diga, así que el tablero —que scrollea de
        lado a propósito— empujaba la PÁGINA. Medido a 360 px: 936 px de
        `scrollWidth` contra 360 de ventana. */}
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-4 px-6 pt-3">
        <EncabezadoDePagina titulo="Oportunidades" className="mb-0" />
        {pipelines.length > 1 && (
          <Select
            value={pipelineId}
            onValueChange={(valor) => { setPipelineId(valor); primeraLista(); }}
          >
            <SelectTrigger className="h-9 bg-field text-sm" aria-label="Pipeline"><SelectValue /></SelectTrigger>
            <SelectContent>
            {pipelines.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
            </Select>
        )}
        {/* Sin botón de IA acá: el topbar ya tiene «Pídeselo a IAxTi» en todas
            las pantallas, y dos botones con las mismas palabras a seis
            centímetros es lo que se lee como inacabado. Lo que el tablero sí
            necesitaba era que la capacidad exista, y existe: el Agente General
            tiene las operaciones del CRM entre sus herramientas —listar, mover
            de etapa, crear, renombrar el embudo, reordenar las etapas—, porque
            el catálogo se genera del OpenAPI de la API. */}
        <Tabs value={vista} onValueChange={(v) => setVista(v as typeof vista)} className="ml-auto">
          <TabsList>
            <TabsTrigger value="tablero">Tablero</TabsTrigger>
            <TabsTrigger value="lista">Lista</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {aviso && (
        <div className="shrink-0 px-6">
          <AvisoResultado>
            {aviso}
          </AvisoResultado>
        </div>
      )}

      {vista === 'tablero' && pipeline.stages.every((s) => columnas[s.id] && !columnas[s.id].cargando && columnas[s.id].items.length === 0) ? (
        <EstadoVacio className="m-6" titulo="Sin oportunidades abiertas"
          descripcion="Aquí verás cada venta en su etapa. Desde una conversación puedes crear la primera oportunidad y seguirla en este embudo."
          accion={{ etiqueta: 'Ir a una conversación', href: '/bandeja' }} />
      ) : vista === 'tablero' ? (
        /* Columnas deslizables: al Kanban se entra desde 360 px (§29). */
        /* `scroll-px-6` y no solo `px-6`: `snap-start` alinea la columna con el
             inicio del área de scroll, que NO incluye el relleno, así que al
             cargar el tablero se desplazaba 24 px solo y la primera columna
             quedaba pegada al borde izquierdo. Se vio en la captura de
             celular. */
        <DndContext
          sensors={sensores}
          accessibility={{
            announcements: anuncios,
            /* La voz del producto, no la de la librería: lector de pantalla en
               español de Chile, con el gesto y el Escape donde se esperan. */
            screenReaderInstructions: {
              draggable: 'Para mover una oportunidad, aprieta Espacio, muévete con las flechas izquierda o derecha y suelta con Espacio. Escape la devuelve a su etapa.',
            },
          }}
          onDragStart={({ active }) => setArrastrando(todas.find((d) => d.id === active.id) ?? null)}
          onDragEnd={alSoltar}
          onDragCancel={() => setArrastrando(null)}
        >
          <CifrasDelEmbudo etapas={pipeline.stages} resumen={resumen} ganadoMes={ganadoMes} />
          <LecturaDelEmbudo embudo={embudo} />
          <div className="flex min-h-0 flex-1 snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-6">
            {pipeline.stages.map((stage) => (
              <ColumnaEtapa
                key={stage.id}
                stage={stage}
                col={columnas[stage.id]}
                total={resumen[stage.id]}
                etapa={embudo?.etapas.find((e) => e.stageId === stage.id)}
                abierta={abierta}
                onAbrir={setAbierta}
                onCargarMas={(cursor) => void cargarColumna(stage, cursor)}
              />
            ))}
          </div>
          {/* La tarjeta que flota: el mismo cuerpo sin oyentes, con el
              filete de profundidad de lo que flota (ADR-0034) y apenas
              girada, para que el ojo la siga por encima del tablero. */}
          <DragOverlay>
            {arrastrando ? (
              <div className="w-72 rotate-1 rounded-campo border border-action bg-bg p-3 shadow-flotante">
                <CuerpoTarjeta deal={arrastrando} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {/* Filtros + guardados por usuario. */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-muted">
              Etapa
              <Select
                value={filtros.stageId ?? TODAS}
                onValueChange={(valor) => setFiltros({ ...filtros, stageId: valor === TODAS ? '' : valor })}
              >
                <SelectTrigger className="mt-1 h-9 w-full bg-field text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                <SelectItem value={TODAS}>Todas</SelectItem>
                {pipeline.stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            </label>
            <label className="text-sm text-muted">
              Dueño
              <Select
                value={filtros.owner || VISIBILIDAD}
                onValueChange={(valor) => setFiltros({ ...filtros, owner: valor === VISIBILIDAD ? '' : valor })}
              >
                <SelectTrigger className="mt-1 h-9 w-full bg-field text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={VISIBILIDAD}>Según mi visibilidad</SelectItem>
                  <SelectItem value="me">Solo las mías</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="text-sm text-muted">
              Valor desde (CLP)
              <Input
                type="number"
                className="dato mt-1 h-9 w-32 text-sm"
                value={filtros.valueClpMin ?? ''}
                onChange={(e) => setFiltros({ ...filtros, valueClpMin: e.target.value })}
              />
            </label>
            <label className="text-sm text-muted">
              hasta
              <Input
                type="number"
                className="dato mt-1 h-9 w-32 text-sm"
                value={filtros.valueClpMax ?? ''}
                onChange={(e) => setFiltros({ ...filtros, valueClpMax: e.target.value })}
              />
            </label>
            <label className="text-sm text-muted">
              Etiqueta
              <Input
                className="mt-1 h-9 w-32 text-sm"
                value={filtros.tag ?? ''}
                onChange={(e) => setFiltros({ ...filtros, tag: e.target.value })}
              />
            </label>
            <Button variant="secundario" size="chico" onClick={() => void cargarLista()}>
              Filtrar
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {guardados.map((g) => (
              <Badge key={g.id} role="action">
                <button type="button" onClick={() => { setFiltros(g.filters); }}>
                  {g.name}
                </button>
                <button
                  type="button"
                  aria-label={`Borrar filtro ${g.name}`}
                  className="ml-1 opacity-60 hover:opacity-100"
                  onClick={() => {
                    void api(`/saved-filters/${g.id}`, { method: 'DELETE' }).then(() =>
                      setGuardados((prev) => prev.filter((x) => x.id !== g.id)),
                    );
                  }}
                >
                  ×
                </button>
              </Badge>
            ))}
            <Input
              placeholder="Guardar filtro como"
              className="h-9 w-44 text-sm"
              value={nombreFiltro}
              onChange={(e) => setNombreFiltro(e.target.value)}
            />
            <Button
              variant="fantasma"
              size="chico"
              disabled={!nombreFiltro.trim()}
              onClick={() => {
                void api<SavedFilterDto>('/saved-filters', {
                  method: 'POST',
                  body: JSON.stringify({ name: nombreFiltro.trim(), filters: filtros }),
                }).then((g) => {
                  setGuardados((prev) => [...prev.filter((x) => x.name !== g.name), g]);
                  setNombreFiltro('');
                });
              }}
            >
              Guardar
            </Button>
          </div>

          <DataTable label="Oportunidades" columns={columnasLista} rows={lista} sorting={sorting}
            onSort={(sort) => { setSorting(sort); primeraLista(); }} selection={selection} onSelection={setSelection}
            nextCursor={listaCursor} loading={cargandoLista} mobileColumns={['title']} canPrevious={historialLista.length > 0}
            onNext={() => { if (listaCursor) { setHistorialLista((h) => [...h, listaActual]); setListaActual(listaCursor); setSelection({}); } }}
            onPrevious={() => { setListaActual(historialLista.at(-1)); setHistorialLista((h) => h.slice(0, -1)); setSelection({}); }}>
            <EtiquetarSeleccion tenant={tenant} contactIds={lista.filter((d) => selection[d.id]).map((d) => d.contactId)} onDone={() => setSelection({})} />
          </DataTable>
          {lista.length === 0 && <EstadoVacio className="mt-4"
            titulo={Object.values(filtros).some(Boolean) ? 'Ninguna oportunidad coincide' : 'Sin oportunidades abiertas'}
            descripcion={Object.values(filtros).some(Boolean) ? 'Quita los filtros para volver a ver las oportunidades del embudo.' : 'Crea una oportunidad desde una conversación para seguir la venta por sus etapas.'}
            accion={Object.values(filtros).some(Boolean) ? { etiqueta: 'Limpiar filtros', onClick: () => { setFiltros({}); primeraLista(); } } : { etiqueta: 'Ir a una conversación', href: '/bandeja' }} />}

        </div>
      )}

      {/* Motivo al retroceder o al perder (§10). */}
      <Dialog open={pendiente !== null} onOpenChange={(abierto) => !abierto && setPendiente(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendiente?.hasta.type === 'lost' ? 'Cerrar como perdida' : 'Retroceder de etapa'}
            </DialogTitle>
            <DialogDescription>
              {pendiente?.hasta.type === 'lost'
                ? 'Elige el motivo de la lista del negocio; queda en la historia.'
                : 'Cuéntanos el motivo; queda en la historia de la oportunidad.'}
            </DialogDescription>
          </DialogHeader>
          {pendiente?.hasta.type === 'lost' ? (
            <Select value={motivoPerdidaId} onValueChange={setMotivoPerdidaId}>
              <SelectTrigger className="h-control w-full bg-field" aria-label="Motivo de pérdida"><SelectValue /></SelectTrigger>
              <SelectContent>
              {motivos.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
              ))}
            </SelectContent>
            </Select>
          ) : (
            <Input
              aria-label="Motivo"
              placeholder="Motivo del retroceso"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          )}
          <DialogFooter>
            <Button variant="secundario" onClick={() => setPendiente(null)}>Cancelar</Button>
            <Button
              disabled={pendiente?.hasta.type === 'lost' ? !motivoPerdidaId : !motivo.trim()}
              onClick={() => {
                if (!pendiente) return;
                const extra: Record<string, string> =
                  pendiente.hasta.type === 'lost'
                    ? { lostReasonId: motivoPerdidaId }
                    : { reason: motivo.trim() };
                void ejecutarMovimiento(pendiente.deal, pendiente.hasta, extra).then(() =>
                  setPendiente(null),
                );
              }}
            >
              {pendiente?.hasta.type === 'lost' ? 'Cerrar perdida' : 'Mover'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    {abierta && (
      <FichaOportunidad
        /* `version` en la key: al mover, la ficha se re-pide y no sigue
           mostrando la etapa de la que ya se fue (#1367). */
        key={`${abierta}-${version}`}
        dealId={abierta}
        onCerrar={() => setAbierta(null)}
        stages={pipeline?.stages ?? []}
        stageIdActual={todas.find((d) => d.id === abierta)?.stageId ?? null}
        onMover={(hasta) => {
          const deal = todas.find((d) => d.id === abierta);
          if (deal) soltar(deal, hasta);
        }}
      />
    )}
    </div>
  );
}
