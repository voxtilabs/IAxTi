'use client';

import { AvisoResultado } from '@iaxti/ui/react';
import { Seccion } from '@iaxti/ui/react';

import { Bot } from 'lucide-react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Textarea, useSession } from '@iaxti/ui/react';
import { SelectorDeAsistente, useAsistenteElegido } from './selector-de-asistente';
import { apiFetch, mensajeDeError } from '../lib/api';

// Modo autónomo (#49): la IA responde sola SOLO por horario o marca manual
// — jamás por defecto. Aquí viven el horario y los guardrails del tenant.
//
// Y desde #1230, el resto de lo configurable: el tono, la firma, el aviso al
// derivar, a quién le queda la conversación derivada y el pulso. Todo eso ya
// existía en `agents.limits` o en una columna de `agents`, el motor ya lo
// leía, y no tenía NINGÚN escritor en el producto: lo ponía el seed, el Agente
// General, o un script por SSH. Medido antes de esto: 6 perillas en pantalla
// contra 11 que el motor respeta. Dicho por el dueño del negocio: «está muy
// poco configurable los agentes».

/** «Nadie en particular» como valor del desplegable: Radix no acepta `value=""`. */
const NADIE = '__nadie__';

const DIAS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

/**
 * Lo que la pantalla PROPONE cuando el pulso todavía no tiene números.
 *
 * Son los mismos valores por defecto de `configDelPulso` (#1210), y la guarda
 * `el-pulso-se-prende-desde-la-pantalla` los compara contra esa fuente.
 * Proponer otros sería mostrarle al negocio un ritmo distinto del que va a
 * correr, y el pulso es lo único de esta pantalla que le escribe a un cliente
 * por su cuenta.
 */
const PULSO_CADA_MINUTOS = 40;
const PULSO_MAX_POR_PERSONA = 6;

/**
 * El horario del pulso no tiene valor por defecto en el motor, a propósito:
 * sin `desde` y `hasta` escritos `configDelPulso` devuelve null, para no
 * escribirle a nadie a las tres de la mañana. Así que estos dos son solo lo
 * que el campo propone — y prender el interruptor los ESCRIBE (`prenderPulso`).
 */
const PULSO_DESDE = '09:00';
const PULSO_HASTA = '18:00';

interface PulsoDto {
  activo?: boolean;
  cada_minutos?: number;
  desde?: string;
  hasta?: string;
  max_por_persona?: number;
}

interface LimitesDto {
  confidence_threshold?: number;
  max_agent_turns?: number;
  money_limit_clp?: number;
  escalation_notice?: string;
  handoff_user_id?: string;
  firma_en_cada_mensaje?: boolean;
  firma?: string;
  /* No la edita esta pantalla, pero viaja para no borrarse (#1235). */
  actua_como_user_id?: string | null;
  pulso?: PulsoDto;
}

interface AgenteDto {
  id: string;
  name: string;
  active: boolean;
  personality: string | null;
  /** Los dos que deciden si el tono llega al modelo: ver `tonoSeIgnora`. */
  promptName: string | null;
  fallbackSystemPrompt: string | null;
  defaultMode: 'assist' | 'autonomous' | 'off';
  autonomousHours: { start?: string; end?: string; days?: number[] };
  limits: LimitesDto;
}

const LLAVES_DE_LIMITS = [
  'confidence_threshold',
  'max_agent_turns',
  'money_limit_clp',
  'handoff_user_id',
  'escalation_notice',
  'firma_en_cada_mensaje',
  'firma',
  'actua_como_user_id',
  'pulso',
] as const satisfies readonly (keyof LimitesDto)[];

/*
 * Que la lista esté COMPLETA lo exige el compilador, no la memoria.
 *
 * Si `LimitesDto` gana una llave y nadie la agrega acá, esta línea no compila.
 * Sin ella, el olvido no da error: la llave se borra en silencio en el próximo
 * guardado. Pasó al rebasar esto sobre `staging`, que había agregado
 * `firma_en_cada_mensaje` — y el comentario de abajo ya advertía del riesgo
 * mientras la lista lo tenía.
 */
type FaltaDeclarar = Exclude<keyof LimitesDto, (typeof LLAVES_DE_LIMITS)[number]>;
const _todasDeclaradas: FaltaDeclarar extends never ? true : FaltaDeclarar = true;
void _todasDeclaradas;

/**
 * Lo que vuelve al servidor: lo conocido, y nada más (#1232).
 *
 * Antes era un `{ ...limits }` pelado. Desde que el PUT valida lo que recibe,
 * RECHAZA una llave que nadie lee, así que un `limits` con basura heredada
 * —hubo un `max_executions_day` nombrado en el comentario de la migración
 * desde el primer día— dejaría esta pantalla sin poder guardar nada, y el
 * error hablaría de una llave que el dueño nunca escribió.
 *
 * La lista incluye `pulso`, que llegó después en #1210: una lista blanca que
 * se olvida de una llave nueva la borra en silencio en el próximo guardado, y
 * eso apagaría el pulso del evento sin que nadie toque el pulso.
 */
function limitesConocidos(limits: LimitesDto): LimitesDto {
  const salida: Record<string, unknown> = {};
  for (const llave of LLAVES_DE_LIMITS) {
    if (limits[llave] !== undefined) salida[llave] = limits[llave];
  }
  return salida as LimitesDto;
}

interface MiembroDto {
  userId: string;
  nombre: string | null;
  email: string | null;
}

/**
 * El pulso de este asistente va a correr de verdad: prendido Y con horario.
 *
 * Las dos condiciones son las de `configDelPulso` y van juntas porque por
 * separado mienten: `activo: true` sin horario no manda nada, y mostrar
 * «prendido» ahí es justo el estado que hace que un negocio crea que su
 * asistente está retomando conversaciones mientras no hace nada.
 */
function pulsoPrendido(p: PulsoDto | undefined): boolean {
  return p?.activo === true && Boolean(p.desde) && Boolean(p.hasta);
}

function estadoDelPulso(p: PulsoDto): 'prendido' | 'sin_horario' | 'apagado' {
  if (pulsoPrendido(p)) return 'prendido';
  return p.activo === true ? 'sin_horario' : 'apagado';
}

export function ModoAutonomo() {
  const { config, session } = useSession();
  // Tomaba el primero de la lista: con dos asistentes, quien configuraba el
  // modo autónomo tocaba siempre ese creyendo que tocaba el que estaba
  // mirando — y este es el ajuste donde equivocarse se nota en la cara de
  // un cliente (#494).
  const { tenant, asistentes, elegido: agente, elegir, reemplazar } = useAsistenteElegido<AgenteDto>();
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  // `null` mientras se pide, `[]` cuando no se pudo. Son estados distintos: el
  // primero deja el selector quieto y el segundo dice por qué quedó apagado.
  const [equipo, setEquipo] = useState<MiembroDto[] | null>(null);
  const [sinEquipo, setSinEquipo] = useState(false);

  const cargarEquipo = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const r = await apiFetch<{ miembros: MiembroDto[] }>(config, session, tenant, '/equipo');
      setEquipo(r.miembros);
      setSinEquipo(false);
    } catch {
      // `GET /equipo` pide el módulo `identity` y el permiso `users.read`, y
      // sin eso contesta 403. Eso no puede llevarse la sección: las otras
      // cuatro perillas de este bloque no dependen del equipo. El selector se
      // apaga y dice qué pasó.
      setEquipo([]);
      setSinEquipo(true);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargarEquipo(), [cargarEquipo]);

  if (!tenant || asistentes === null) return <div className="mt-4 max-w-xl"><Skeleton className="h-24" /></div>;
  if (!agente) return null;

  const hours = agente.autonomousHours ?? {};
  const limits = agente.limits ?? {};
  const pulso = limits.pulso ?? {};
  const dias = hours.days ?? [1, 2, 3, 4, 5];

  const guardar = async (cambios: Partial<AgenteDto>) => {
    setAviso(null);
    setGuardado(false);
    try {
      const actualizado = await apiFetch<AgenteDto>(config, session!, tenant, `/agents/${agente.id}`, {
        method: 'PUT',
        // El filtro va acá, en el borde, y no en `guardarLimites`: la guarda
        // de #1230 exige que el único literal de `limits` arranque con
        // `...limits` para que nadie olvide el spread, y envolverlo en una
        // llamada lo escondía de esa comprobación. Acá es además el único
        // punto por donde salen los límites al servidor.
        body: JSON.stringify(
          cambios.limits ? { ...cambios, limits: limitesConocidos(cambios.limits) } : cambios,
        ),
      });
      reemplazar(actualizado);
      setGuardado(true);
    } catch (err) {
      setAviso(mensajeDeError(err));
    }
  };

  /**
   * Cambiar UNA llave de `limits` manda el objeto ENTERO.
   *
   * El PUT hace `limits = COALESCE($14::jsonb, limits)`: reemplaza el jsonb
   * completo, no lo mergea. Mandar `{ escalation_notice }` sola borra de un
   * golpe la confianza, los turnos, el tope de dinero, el destinatario y el
   * pulso — y sin error en ninguna parte, porque el PUT responde 200 con el
   * agente ya vaciado. Por eso ninguna escritura de esta pantalla arma el
   * objeto a mano: todas pasan por acá, y la guarda de fuente comprueba que
   * siga siendo la única.
   */
  const guardarLimites = (cambio: Partial<LimitesDto>) => guardar({ limits: { ...limits, ...cambio } });

  /** Lo mismo un nivel más adentro: `pulso` también se reemplaza entero. */
  const guardarPulso = (cambio: Partial<PulsoDto>) => guardarLimites({ pulso: { ...pulso, ...cambio } });

  const prenderPulso = (activo: boolean) =>
    guardarPulso(
      activo
        ? {
            activo: true,
            // El horario se escribe AL PRENDER: el guardado, o el propuesto si
            // todavía no hay. Sin esto queda `activo: true` sin `desde`/`hasta`,
            // `configDelPulso` devuelve null, y el negocio se queda mirando un
            // interruptor prendido que no manda un solo mensaje.
            //
            // Es el guardado y no lo que el campo tenga a medio escribir: una
            // hora tipeada y sin salir del campo todavía no pasó por su `blur`,
            // así que acá no existe. Al prender, el clic saca el foco del campo
            // y ese `blur` guarda la hora tipeada por su cuenta.
            desde: pulso.desde ?? PULSO_DESDE,
            hasta: pulso.hasta ?? PULSO_HASTA,
          }
        : { activo: false },
    );

  /**
   * El pulso corre con el PRIMER asistente activo que lo tenga prendido
   * (`agenteConPulso`), no con todos. Dos prendidos no son dos pulsos, y sin
   * decirlo el segundo muestra su ritmo en pantalla y no escribe nada.
   */
  const elQuePulsa = asistentes.find((a) => a.active && pulsoPrendido(a.limits?.pulso));
  const otroPulsa = elQuePulsa !== undefined && elQuePulsa.id !== agente.id;

  /**
   * El tono solo llega al modelo cuando el asistente NO tiene prompt propio:
   * `runtime.ts` arma el prompt del sistema como
   * `promptName ?? fallbackSystemPrompt ?? plantilla-con-la-personalidad`. El
   * seed y el Agente General escriben `fallbackSystemPrompt`, así que en un
   * tenant sembrado este campo se guarda y no se usa.
   *
   * Se dice en pantalla en vez de arreglarse acá: cambiar cómo se arma el
   * prompt mueve el dataset de regresión del agente (#53), y eso no es un
   * cambio de interfaz.
   */
  const tonoSeIgnora = Boolean(agente.promptName ?? agente.fallbackSystemPrompt);

  const destinatario = limits.handoff_user_id ?? null;
  // Quien recibía las derivaciones puede haber salido del equipo. Sin esta
  // opción el desplegable se dibuja VACÍO, y un desplegable vacío se lee como
  // «no hay nadie elegido» cuando en realidad hay un id guardado al que se le
  // sigue asignando la conversación.
  const destinatarioYaNoEsta =
    destinatario !== null && equipo !== null && !equipo.some((m) => m.userId === destinatario);

  /**
   * Cambiar de asistente REMONTA los bloques, y sin eso la pantalla miente.
   *
   * Los campos de acá son no controlados (`defaultValue`), que es lo que
   * permite escribir tranquilo y guardar al salir del campo. El precio es que
   * React ignora un `defaultValue` nuevo en un input YA montado: el selector
   * cambia `agente` y reconcilia el MISMO árbol, así que elegir el segundo
   * asistente dejaba en pantalla los números y el tono del primero con el PUT
   * ya apuntando al segundo. Y el siguiente `blur` —tocar y salir alcanza—
   * escribía el valor del primero encima del segundo.
   *
   * Es el defecto de #494 a medias: el selector acertaba a QUIÉN se le guarda
   * y la pantalla seguía mostrando al otro. Medido: en staging eran 3 campos
   * así, acá son 9 más el área de texto del tono, que es donde confundir dos
   * asistentes se ve de inmediato.
   *
   * Va en la `key` y no en estado controlado porque el id es exactamente la
   * condición: mientras sea el mismo asistente, guardar NO tiene que pisar lo
   * que haya a medio escribir en otro campo — `reemplazar` devuelve el mismo
   * id, así que la key no cambia y no se remonta nada.
   */
  const bloque = agente.id;

  return (
    <>
      <Seccion key={`modo-${bloque}`} className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="rotulo">Modo autónomo</span>
          <SelectorDeAsistente asistentes={asistentes} elegidoId={agente.id} onElegir={elegir} />
          {agente.defaultMode === 'autonomous' ? (
            <Badge role="warn"><Bot className="mr-1 inline-block size-3 align-[-0.1em]" aria-hidden />Por horario</Badge>
          ) : (
            <Badge role="neutral">Solo sugiere</Badge>
          )}
        </div>
        <p className="mt-2 max-w-prose text-sm text-muted">
          {agente.name} responde sola únicamente dentro del horario que definas aquí, o cuando tú
          enciendas el piloto automático en una conversación. Nunca por defecto. Ante enojo, temas de
          dinero fuera de rango o &quot;quiero hablar con una persona&quot;, te la pasa de vuelta y avisa.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-body">Cuando nadie mira</span>
          <Select
            value={agente.defaultMode}
            onValueChange={(v) => void guardar({ defaultMode: v as AgenteDto['defaultMode'] })}
          >
            <SelectTrigger aria-label="Modo por defecto" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="assist">Solo sugiere (recomendado)</SelectItem>
              <SelectItem value="autonomous">Responde sola en el horario de abajo</SelectItem>
              <SelectItem value="off">Apagada</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {agente.defaultMode === 'autonomous' && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              aria-label="Desde"
              type="time"
              className="w-28 font-mono"
              defaultValue={hours.start ?? '19:00'}
              onBlur={(e) => void guardar({ autonomousHours: { ...hours, start: e.target.value, days: dias } })}
            />
            <span className="text-sm text-muted">a</span>
            <Input
              aria-label="Hasta"
              type="time"
              className="w-28 font-mono"
              defaultValue={hours.end ?? '09:00'}
              onBlur={(e) => void guardar({ autonomousHours: { ...hours, end: e.target.value, days: dias } })}
            />
            <span className="ml-2 flex gap-1">
              {DIAS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={dias.includes(i)}
                  className={`h-8 w-8 rounded-boton border text-xs font-bold ${
                    dias.includes(i)
                      ? 'border-action bg-action-soft text-action-text'
                      : 'border-line bg-bg text-faint'
                  }`}
                  onClick={() =>
                    void guardar({
                      autonomousHours: {
                        ...hours,
                        days: dias.includes(i) ? dias.filter((x) => x !== i) : [...dias, i].sort(),
                      },
                    })
                  }
                >
                  {d}
                </button>
              ))}
            </span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-body">
            Confianza mínima
            <Input
              type="number" min={0.1} max={1} step={0.05}
              className="font-mono"
              defaultValue={limits.confidence_threshold ?? 0.7}
              onBlur={(e) => void guardarLimites({ confidence_threshold: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Turnos sin avanzar
            <Input
              type="number" min={2} max={20}
              className="font-mono"
              defaultValue={limits.max_agent_turns ?? 5}
              onBlur={(e) => void guardarLimites({ max_agent_turns: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Tope de dinero (CLP)
            <Input
              type="number" min={0} step={1000}
              className="font-mono"
              placeholder="Sin tope: siempre escala"
              defaultValue={limits.money_limit_clp ?? ''}
              onBlur={(e) => void guardarLimites({ money_limit_clp: e.target.value ? Number(e.target.value) : undefined })}
            />
          </label>
        </div>
      </Seccion>

      <Seccion
        key={`asistente-${bloque}`}
        rotulo="Asistente"
        titulo="Cómo habla y a quién te la pasa"
        apoyo={`Cuatro cosas que ${agente.name} ya respeta y que hasta ahora solo se podían escribir por fuera del producto.`}
      >
        <label className="flex flex-col gap-1 text-sm text-body">
          El tono
          <Textarea
            rows={4}
            placeholder="Cercana y directa, trata de tú, frases cortas. Nunca promete descuentos."
            defaultValue={agente.personality ?? ''}
            onBlur={(e) => void guardar({ personality: e.target.value })}
          />
        </label>
        <p className="mt-1 max-w-prose text-rotulo text-muted">
          Cómo habla, en tus palabras. No es lo que sabe —eso se carga en Conocimiento— ni lo que
          tiene que lograr: es la voz.
        </p>
        {tonoSeIgnora && (
          <p className="mt-2 max-w-prose rounded-campo border border-warn-soft-br bg-warn-soft p-3 text-rotulo text-warn-text">
            Este asistente tiene un prompt propio escrito, y ese prompt manda sobre el tono: lo que
            escribas acá se guarda, pero el modelo no lo va a leer. Para cambiarle la voz, pídeselo
            conversando en «Tu asistente».
          </p>
        )}

        <label className="mt-4 flex items-center gap-3 text-sm text-body">
          <Switch
            checked={limits.firma_en_cada_mensaje !== false}
            onCheckedChange={(v) => void guardarLimites({ firma_en_cada_mensaje: v })}
            aria-label="Firmar cada mensaje"
          />
          Firmar cada mensaje
        </label>
        <p className="mt-1 max-w-prose text-rotulo text-muted">
          Apagado, firma solo el primer mensaje de cada conversación. Quien lee sigue sabiendo que
          habla con un asistente y cómo pedir una persona; lo que deja de pasar es que esa línea se
          repita en cada respuesta.
        </p>

        <label className="mt-4 flex flex-col gap-1 text-sm text-body">
          El aviso al derivar
          <Input
            placeholder="Gracias por escribirnos. Te va a responder una persona del equipo."
            defaultValue={limits.escalation_notice ?? ''}
            onBlur={(e) => void guardarLimites({ escalation_notice: e.target.value })}
          />
        </label>
        <p className="mt-1 max-w-prose text-rotulo text-muted">
          Lo que recibe el cliente cuando {agente.name} suelta el control. Sin plazos que no puedas
          cumplir: abajo va siempre el nombre del asistente.
        </p>

        <label className="mt-4 flex flex-col gap-1 text-sm text-body">
          A quién le queda la conversación
          <Select
            value={destinatario ?? NADIE}
            onValueChange={(v) => void guardarLimites({ handoff_user_id: v === NADIE ? undefined : v })}
            disabled={equipo === null || sinEquipo}
          >
            <SelectTrigger aria-label="A quién le queda la conversación" className="w-full sm:w-96">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NADIE}>A quien ya la tenía</SelectItem>
              {destinatarioYaNoEsta && destinatario !== null && (
                <SelectItem value={destinatario}>Alguien que ya no está en el equipo</SelectItem>
              )}
              {(equipo ?? []).map((m) => (
                // Nunca «Sin nombre» (#1139): quien no puso nombre tiene correo,
                // y quien tampoco tiene correo se identifica por su id, que es
                // con lo que se lo puede buscar.
                <SelectItem key={m.userId} value={m.userId}>{m.nombre ?? m.email ?? m.userId}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <p className="mt-1 max-w-prose text-rotulo text-muted">
          {sinEquipo
            ? 'No pudimos leer tu equipo, así que esto queda apagado. Las derivaciones siguen funcionando: la conversación le queda a quien ya la tenía.'
            : 'Al derivar, la conversación se le asigna a esta persona. Sin elegir a nadie le queda al dueño que ya tenía.'}
        </p>
      </Seccion>

      <Seccion
        key={`pulso-${bloque}`}
        rotulo="Pulso"
        titulo="Retomar conversaciones solo"
        apoyo="Lo único de esta pantalla que le escribe a un cliente sin que nadie apriete nada. Nace apagado."
        accion={<EstadoDelPulso pulso={pulso} />}
      >
        <label className="flex items-center gap-3 text-sm text-body">
          <Switch
            checked={pulso.activo === true}
            onCheckedChange={(v) => void prenderPulso(v)}
            aria-label="Retomar conversaciones solo"
          />
          {agente.name} vuelve a escribirle a quien le escribió
        </label>
        <p className="mt-1 max-w-prose text-rotulo text-muted">
          Solo a quien tiene la ventana de 24 h abierta, dentro del horario de abajo y hasta el tope
          por persona. Fuera de la ventana no sale nada: eso pide una plantilla aprobada.
        </p>

        {otroPulsa && elQuePulsa !== undefined && (
          <p className="mt-3 max-w-prose rounded-campo border border-warn-soft-br bg-warn-soft p-3 text-rotulo text-warn-text">
            El pulso lo está dando {elQuePulsa.name}. Corre con un solo asistente a la vez, así que
            prenderlo acá no agrega un segundo pulso: apaga el de {elQuePulsa.name} primero.
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-body">
            Cada cuántos minutos
            <Input
              type="number" min={5} step={5}
              className="font-mono"
              defaultValue={pulso.cada_minutos ?? PULSO_CADA_MINUTOS}
              onBlur={(e) => void guardarPulso({ cada_minutos: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Tope por persona al día
            <Input
              type="number" min={1} max={14}
              className="font-mono"
              defaultValue={pulso.max_por_persona ?? PULSO_MAX_POR_PERSONA}
              onBlur={(e) => void guardarPulso({ max_por_persona: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Desde
            <Input
              type="time"
              className="font-mono"
              defaultValue={pulso.desde ?? PULSO_DESDE}
              onBlur={(e) => void guardarPulso({ desde: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-body">
            Hasta
            <Input
              type="time"
              className="font-mono"
              defaultValue={pulso.hasta ?? PULSO_HASTA}
              onBlur={(e) => void guardarPulso({ hasta: e.target.value })}
            />
          </label>
        </div>
        <p className="mt-2 max-w-prose text-rotulo text-muted">
          El tope existe por una razón medida: entre las 9 y las 18, cada 40 minutos caben catorce
          mensajes al mismo teléfono en un día, y ese es el patrón por el que Meta castiga un
          número.
        </p>

        {guardado && <AvisoResultado tono="success">Listo, quedó guardado.</AvisoResultado>}
        {aviso && <AvisoResultado>{aviso}</AvisoResultado>}
      </Seccion>
    </>
  );
}

/**
 * Si el pulso está prendido y a qué ritmo, en el encabezado del bloque.
 *
 * Va acá y no dentro de algo que haya que desplegar porque es lo que hay que
 * poder ver sin abrir nada: el pulso escribe por su cuenta, y «¿está
 * escribiendo, y cada cuánto?» es la pregunta de quien entra a mirar.
 */
function EstadoDelPulso({ pulso }: { pulso: PulsoDto }) {
  const estado = estadoDelPulso(pulso);
  if (estado === 'apagado') return <Badge role="neutral">Apagado</Badge>;
  if (estado === 'sin_horario') return <Badge role="bad">Prendido sin horario: no manda nada</Badge>;
  return (
    <Badge role="warn">
      <Bot className="size-3" aria-hidden />
      Escribe solo cada <span className="font-mono">{pulso.cada_minutos ?? PULSO_CADA_MINUTOS}</span> min,
      de <span className="font-mono">{pulso.desde}</span> a <span className="font-mono">{pulso.hasta}</span>
    </Badge>
  );
}
