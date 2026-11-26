'use client';

import { AvisoResultado, EncabezadoDePagina, EstadoVacio, Formulario } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { MessageSquare } from 'lucide-react';
import type { BadgeRole } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe, type Aviso, mensajeDeError } from '../lib/api';

// La pantalla de canales (#45): el estado del número EXPLICADO — un número
// bloqueado por Meta deja al cliente sin su canal de ventas.

interface NumeroDto {
  id: string;
  displayPhone: string | null;
  phoneNumberId: string;
  quality: 'green' | 'yellow' | 'red' | null;
  messagingLimit: string | null;
  businessPausedAt?: string | null;
  /** Desconectado y archivado (#600): ya no ocupa cupo del plan. */
  disconnectedAt?: string | null;
}

/** Lo que contesta la prueba de envío (#587). */
interface ResultadoPruebaDto {
  ok: boolean;
  motivo: string | null;
  mensaje: string;
  detalle?: string;
  providerMessageId?: string;
}

interface WidgetDto {
  id: string;
  name: string;
  allowedDomain: string;
  active: boolean;
}

interface CanalDto {
  id: string;
  kind: string;
  name: string;
  state: 'connecting' | 'active' | 'degraded' | 'disconnected';
  numbers: NumeroDto[];
}

const ESTADO_CANAL: Record<CanalDto['state'], { label: string; role: BadgeRole; ayuda: string }> = {
  connecting: { label: 'Conectando', role: 'neutral', ayuda: 'Terminando la conexión con el proveedor.' },
  active: { label: 'Activo', role: 'good', ayuda: 'Recibiendo y enviando con normalidad.' },
  degraded: { label: 'Degradado', role: 'warn', ayuda: 'Funciona con restricciones: revisa la calidad del número.' },
  disconnected: { label: 'Desconectado', role: 'bad', ayuda: 'Sin conexión: los mensajes no entran ni salen.' },
};

const CALIDAD: Record<string, { label: string; role: BadgeRole; ayuda: string }> = {
  green: { label: 'Calidad buena', role: 'good', ayuda: 'Meta ve buenas respuestas de tus clientes. Todo normal.' },
  yellow: { label: 'Calidad media', role: 'warn', ayuda: 'Algunos clientes reportaron o bloquearon mensajes. Cuida el contenido y la frecuencia.' },
  red: { label: 'Calidad baja', role: 'bad', ayuda: 'Meta puede restringir el número. Pausamos los envíos del negocio para protegerlo; responder conversaciones sigue funcionando.' },
};


/**
 * Probar sin número real (#41).
 *
 * `POST /v1/dev/inbound` encola un entrante por el MISMO camino que el
 * canal de verdad: la misma cola, el mismo worker, el mismo copiloto. Es la
 * forma de ver el producto funcionando antes de conectar un número — y la
 * única mientras el número no esté.
 *
 * Existía desde #41 y no había cómo usarlo sin armar un curl a mano.
 *
 * Solo fuera de producción, porque allá la ruta NI SIQUIERA se registra
 * (ver app.module.ts): ofrecer el botón sería ofrecer un 404.
 */
function ProbarSinNumero() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [telefono, setTelefono] = useState('+56961234567');
  const [texto, setTexto] = useState('Hola! Tienen hora para mañana?');
  const [estado, setEstado] = useState<'inicial' | 'enviando' | 'listo' | 'error'>('inicial');
  const [detalle, setDetalle] = useState<string | null>(null);

  if (config.env === 'production') return null;

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || estado === 'enviando') return;
    setEstado('enviando');
    try {
      await apiFetch(config, session, tenant, '/dev/inbound', {
        method: 'POST',
        body: JSON.stringify({ phone: telefono, body: texto, channel: 'simulador' }),
      });
      setEstado('listo');
      setDetalle(null);
    } catch (err) {
      setEstado('error');
      setDetalle(mensajeDeError(err));
    }
  }

  return (
    <section className="mt-8 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
      <h2 className="text-lg font-semibold text-ink">Probar sin número real</h2>
      <p className="mt-2 max-w-prose text-sm text-body">
        Entra por el mismo camino que un WhatsApp de verdad: la misma cola, el mismo copiloto.
      </p>

      <Formulario onSubmit={enviar} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Desde qué teléfono
          <Input
            required
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
            className="dato"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Qué escribe
          <Input required value={texto} onChange={(e) => setTexto(e.target.value)} />
        </label>
        <span>
          <Button type="submit" variant="secundario" disabled={estado === 'enviando'}>
            {estado === 'enviando' ? 'Enviando…' : 'Simular mensaje'}
          </Button>
        </span>
      </Formulario>

      {estado === 'listo' && (
        <AvisoResultado tono="success">
          <span className="font-medium">Entró.</span>{' '}
          <a href="/bandeja" className="underline">
            Míralo en la bandeja
          </a>
          : la sugerencia del copiloto tarda unos segundos en aparecer.
        </AvisoResultado>
      )}
      {estado === 'error' && (
        <AvisoResultado tono="error">
          {detalle}
        </AvisoResultado>
      )}
    </section>
  );
}

interface PasoDto {
  id: string;
  titulo: string;
  estado: 'bien' | 'mal' | 'atencion' | 'desconocido';
  detalle: string;
  queHacer?: string;
}

interface DiagnosticoDto {
  accountId: string;
  problema: string | null;
  pasos: PasoDto[];
}

const TONO_DEL_PASO: Record<PasoDto['estado'], { rol: BadgeRole; texto: string }> = {
  bien: { rol: 'good', texto: 'Bien' },
  atencion: { rol: 'warn', texto: 'Atención' },
  mal: { rol: 'bad', texto: 'Falla' },
  desconocido: { rol: 'neutral', texto: 'Sin datos' },
};

/**
 * Por qué este canal no está recibiendo (#434).
 *
 * «No me llegan los mensajes» tiene cuatro causas que se arreglan en
 * lugares distintos y que desde afuera se ven todas iguales: la bandeja
 * vacía. Esto las separa. Se abre a pedido y no al cargar la pantalla: es
 * una pregunta que se hace cuando algo no anda, no en cada visita.
 */
function Diagnostico({ accountId }: { accountId: string }) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [datos, setDatos] = useState<DiagnosticoDto | null>(null);
  const [mirando, setMirando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mirar = async () => {
    if (!session || !tenant) return;
    setMirando(true);
    setError(null);
    try {
      setDatos(
        await apiFetch<DiagnosticoDto>(config, session, tenant, `/channels/${accountId}/diagnostico`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos revisarlo.');
    } finally {
      setMirando(false);
    }
  };

  return (
    <div className="mt-4">
      <Button variant="secundario" size="chico" onClick={() => void mirar()} disabled={mirando}>
        {mirando ? 'Revisando…' : datos ? 'Revisar de nuevo' : '¿Por qué no llegan los mensajes?'}
      </Button>
      {error && <p className="mt-2 text-sm text-bad-text">{error}</p>}
      {datos && (
        <ul className="mt-3 flex flex-col gap-2">
          {datos.pasos.map((paso) => {
            const tono = TONO_DEL_PASO[paso.estado];
            return (
              <li key={paso.id} className="rounded-campo border border-line bg-bg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge role={tono.rol}>{tono.texto}</Badge>
                  <span className="text-sm font-medium text-ink">{paso.titulo}</span>
                  {datos.problema === paso.id && (
                    <span className="text-xs text-warn-text">— es esto</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-body">{paso.detalle}</p>
                {paso.queHacer && (
                  <p className="mt-1 text-sm text-muted">
                    <strong className="font-medium text-body">Qué hacer:</strong> {paso.queHacer}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Probar el envío por el camino real (#587).
 *
 * De dónde sale: «no puedo enviar mensajes desde la bandeja», tres veces, sin
 * poder contestar ninguna. El diagnóstico de al lado revisa la CONFIGURACIÓN y
 * nada intentaba enviar, así que la diferencia entre «no funciona» y «falta el
 * emisor en la cuenta» costaba una sesión entera.
 *
 * Esto manda un mensaje de verdad, al número que se escriba, por el mismo
 * adaptador y la misma credencial que un mensaje del negocio. Y por eso pide el
 * número explícitamente en vez de ofrecer un botón suelto: lo que sale le llega
 * a una persona.
 *
 * El detalle crudo del proveedor se muestra acá —plegado— y no en la bandeja:
 * es la contraparte de #556. El vendedor lee la frase humana; quien conecta el
 * canal necesita el cuerpo del error.
 */
export function ProbarEnvio({ accountId, kind = 'whatsapp' }: { accountId: string; kind?: string }) {
  const social = kind === 'instagram' || kind === 'messenger';
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [telefono, setTelefono] = useState('');
  const [probando, setProbando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoPruebaDto | null>(null);
  const [error, setError] = useState<Aviso | null>(null);

  const probar = async () => {
    if (!session || !tenant || !telefono.trim()) return;
    setProbando(true);
    setError(null);
    setResultado(null);
    try {
      setResultado(
        await apiFetch<ResultadoPruebaDto>(config, session, tenant, `/channels/${accountId}/probar-envio`, {
          method: 'POST',
          body: JSON.stringify({ telefono: telefono.trim() }),
        }),
      );
    } catch (e) {
      setError(avisoDe(e));
    } finally {
      setProbando(false);
    }
  };

  return (
    <div className="mt-4 rounded-campo border border-line bg-bg p-4">
      <p className="rotulo">Probar el envío</p>
      <p className="mt-1 text-sm text-body">
        Manda un mensaje de prueba por este canal, por el camino real, y te dice exactamente qué
        pasó. Le llega a una persona: usa {social ? 'el identificador de quien' : 'un número que'} te haya escrito en las últimas 24 horas.
      </p>
      <Formulario
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void probar();
        }}
      >
        <Input
          aria-label={social ? 'Identificador del contacto para la prueba' : 'Número para la prueba'}
          placeholder={social ? 'ID del contacto en el canal' : '+56912345678'}
          className="w-48 text-sm"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
        />
        <Button type="submit" variant="secundario" disabled={probando || !telefono.trim()}>
          {probando ? 'Enviando…' : 'Enviar prueba'}
        </Button>
      </Formulario>
      {error && <AvisoResultado tono="error" persistente>{error.texto}{error.rastro && <span className="dato block break-all">{error.rastro}</span>}</AvisoResultado>}
      {resultado && (
        <div className="mt-3">
          <p className="flex flex-wrap items-center gap-2">
            <Badge role={resultado.ok ? 'good' : 'bad'}>{resultado.ok ? 'Salió' : 'No salió'}</Badge>
            {resultado.motivo && <span className="dato text-muted">{resultado.motivo}</span>}
          </p>
          <p className="mt-2 text-sm text-body">{resultado.mensaje}</p>
          {resultado.detalle && (
            <details className="mt-2 text-sm">
              <summary className="w-fit cursor-pointer text-action-text">Ver el detalle técnico</summary>
              <pre className="mt-2 overflow-x-auto rounded-campo border border-line bg-raised p-3 text-xs text-body">
                {resultado.detalle}
              </pre>
            </details>
          )}
          {resultado.ok && (
            <p className="mt-2 text-xs text-muted">
              Esta prueba no queda en la bandeja: queda en el libro de auditoría, con el destinatario y el
              resultado.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Canales() {
  const { session } = useSession();
  const tenant = useSelectedTenant();
  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  return <CanalesDelNegocio key={`${tenant}:${session?.access_token}`} />;
}

/**
 * Los canales como una grilla, uno por TIPO, con su logo (#1391).
 *
 * Antes era una columna de tarjetas casi iguales, cada una con su diagnóstico
 * y su probador abiertos, y el webchat y el simulador mezclados con los
 * canales reales: 1.870 px de alto con la demo, y ningún lugar que dijera
 * «conecta tu WhatsApp». Ahora la pantalla responde una sola pregunta —qué
 * tengo conectado y qué me falta— y todo lo de revisar o probar vive en el
 * detalle de cada canal, sin cambios de comportamiento.
 */
type TipoDeCanal = 'whatsapp' | 'instagram' | 'messenger' | 'webchat';

interface Tipo {
  tipo: TipoDeCanal;
  nombre: string;
  /** El logo oficial (SVG del kit de marca, sin redibujar). Webchat usa un ícono. */
  logo: string | null;
  queEs: string;
  /** Todavía no se puede conectar desde IAxTi (#74, #158). */
  pronto?: boolean;
}

const TIPOS: Tipo[] = [
  { tipo: 'whatsapp', nombre: 'WhatsApp', logo: '/marca/whatsapp-icon.svg', queEs: 'Tu número de WhatsApp Business: las conversaciones llegan a la bandeja.' },
  { tipo: 'instagram', nombre: 'Instagram', logo: '/marca/instagram-icon.svg', queEs: 'Los mensajes directos de tu cuenta de Instagram.', pronto: true },
  { tipo: 'messenger', nombre: 'Messenger', logo: '/marca/messenger-icon.svg', queEs: 'Los mensajes de tu página de Facebook.', pronto: true },
  { tipo: 'webchat', nombre: 'Chat del sitio', logo: null, queEs: 'Un chat en tu página web que cae en la misma bandeja. Sin número.' },
];

/** El estado de un tipo de canal, en una frase y un tono. */
function estadoDelTipo(canales: CanalDto[], widgets: WidgetDto[], tipo: TipoDeCanal) {
  if (tipo === 'webchat') {
    const activos = widgets.filter((w) => w.active);
    if (activos.length === 0) return { conectado: false, rol: 'neutral' as BadgeRole, texto: 'Sin conectar', numero: null };
    return { conectado: true, rol: 'good' as BadgeRole, texto: activos.length === 1 ? `Activo en ${activos[0].allowedDomain}` : `Activo en ${activos.length} sitios`, numero: null };
  }
  const suyos = canales.filter((c) => c.kind === tipo && c.state !== 'disconnected');
  if (suyos.length === 0) return { conectado: false, rol: 'neutral' as BadgeRole, texto: 'Sin conectar', numero: null };
  const conProblema = suyos.find((c) => c.state === 'degraded' || c.numbers.some((n) => n.quality === 'red' || n.businessPausedAt));
  const numero = suyos.flatMap((c) => c.numbers).find((n) => !n.disconnectedAt)?.displayPhone;
  if (conProblema) return { conectado: true, rol: 'warn' as BadgeRole, texto: 'Requiere atención', numero: null };
  // El número va en mono (es un dato); sin número, «Conectado» en letra normal.
  return numero
    ? { conectado: true, rol: 'good' as BadgeRole, texto: numero, numero }
    : { conectado: true, rol: 'good' as BadgeRole, texto: suyos.length === 1 ? 'Conectado' : `${suyos.length} cuentas conectadas`, numero: null };
}

function Logo({ tipo }: { tipo: Tipo }) {
  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-campo border border-line bg-bg">
      {tipo.logo ? (
        // El logo oficial de la marca: es la forma en que la gente reconoce
        // el canal de un vistazo, que es justo lo que faltaba.
        <img src={tipo.logo} alt="" className="size-7" />
      ) : (
        <MessageSquare className="size-6 text-muted" strokeWidth={1.5} aria-hidden />
      )}
    </span>
  );
}

function CanalesDelNegocio() {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [canales, setCanales] = useState<CanalDto[] | null>(null);
  const [widgets, setWidgets] = useState<WidgetDto[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<TipoDeCanal | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [nuevosCanales, nuevosWidgets] = await Promise.all([
        apiFetch<CanalDto[]>(config, session, tenant, '/channels'),
        apiFetch<WidgetDto[]>(config, session, tenant, '/webchat/widgets').catch(() => []),
      ]);
      setCanales(nuevosCanales);
      setWidgets(nuevosWidgets);
    } catch (err) {
      setAviso(mensajeDeError(err));
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;
  const tipoAbierto = TIPOS.find((t) => t.tipo === abierto) ?? null;
  // Los canales del simulador no son un tipo que el negocio conecte: son la
  // demo. Su detalle se abre desde el enlace de abajo, no desde la grilla.
  const simulados = (canales ?? []).filter((c) => !TIPOS.some((t) => t.tipo === c.kind));

  return (
    <div className="max-w-4xl">
      <EncabezadoDePagina rotulo="Canales" titulo="Dónde te escriben tus clientes" />

      {aviso && <AvisoResultado>{aviso}</AvisoResultado>}

      {canales === null ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {TIPOS.map((tipo) => {
            const estado = estadoDelTipo(canales, widgets, tipo.tipo);
            return (
              <li key={tipo.tipo} className="pulso-panel flex flex-col gap-4 rounded-tarjeta border border-line bg-raised p-5">
                <div className="flex items-start gap-4">
                  <Logo tipo={tipo} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-display font-semibold text-ink">{tipo.nombre}</span>
                    <span className="mt-1 block text-sm text-body">{tipo.queEs}</span>
                  </span>
                </div>
                <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
                  {tipo.pronto ? (
                    <Badge role="neutral">Próximamente</Badge>
                  ) : (
                    <Badge role={estado.rol}>
                      {estado.numero ? <span className="dato">{estado.numero}</span> : estado.texto}
                    </Badge>
                  )}
                  {!tipo.pronto && (
                    <Button
                      // Un solo primario por vista (ADR-0034): el de WhatsApp,
                      // que es el canal que hay que conectar primero. El resto
                      // se conecta igual, con el botón secundario.
                      variant={!estado.conectado && tipo.tipo === 'whatsapp' ? 'primario' : 'secundario'}
                      size="chico"
                      onClick={() => setAbierto(tipo.tipo)}
                    >
                      {estado.conectado ? 'Administrar' : 'Conectar'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canales !== null && canales.length === 0 && widgets.length === 0 && (
        // El vacío sigue sin ser un callejón (#509): la grilla dice qué
        // conectar, y esto ofrece por dónde empezar.
        <EstadoVacio
          compacto
          className="mt-6"
          titulo="Todavía no hay canales"
          descripcion="Empieza por WhatsApp: es donde te escriben tus clientes. La puesta en marcha te va guiando paso a paso."
          accion={{ etiqueta: 'Ir a la puesta en marcha', href: '/' }}
          pideleAIAxTi="Quiero conectar mi WhatsApp, ¿qué necesito?"
        />
      )}

      {simulados.length > 0 && (
        <p className="mt-6 text-sm text-muted">
          También tienes {simulados.length === 1 ? 'un canal' : `${simulados.length} canales`} de demostración para probar sin número real.{' '}
          <button type="button" className="text-action-text underline" onClick={() => setAbierto('simulador' as TipoDeCanal)}>
            Abrir el simulador
          </button>
        </p>
      )}

      <Dialog open={abierto !== null} onOpenChange={(v: boolean) => !v && setAbierto(null)}>
        <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl">
          {abierto === ('simulador' as TipoDeCanal) ? (
            <>
              <DialogHeader>
                <DialogTitle>Canales de demostración</DialogTitle>
                <DialogDescription>Para ver el producto funcionando antes de conectar un número.</DialogDescription>
              </DialogHeader>
              <DetalleDeCanales canales={simulados} onCambio={cargar} onAviso={setAviso} />
              <ProbarSinNumero />
            </>
          ) : tipoAbierto ? (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <Logo tipo={tipoAbierto} />
                  <span>
                    <DialogTitle>{tipoAbierto.nombre}</DialogTitle>
                    <DialogDescription>{tipoAbierto.queEs}</DialogDescription>
                  </span>
                </div>
              </DialogHeader>
              {tipoAbierto.tipo === 'webchat' ? (
                <DetalleDelWebchat widgets={widgets} onCambio={cargar} onAviso={setAviso} />
              ) : (
                <DetalleDeCanales
                  canales={(canales ?? []).filter((c) => c.kind === tipoAbierto.tipo && c.state !== 'disconnected')}
                  vacio={tipoAbierto.tipo === 'whatsapp' ? <ConectarWhatsApp /> : null}
                  onCambio={cargar}
                  onAviso={setAviso}
                />
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Conectar WhatsApp, dicho como es (#1391).
 *
 * El alta de un número hoy corre por `scripts/conectar-zernio.mjs`: la llave
 * del negocio queda en el entorno del despliegue y hace falta desplegar. Hasta
 * que el alta viva en la app —con su almacén cifrado, issue aparte—, este
 * panel no finge un flujo: dice qué pasa y ofrece el camino real.
 */
function ConectarWhatsApp() {
  return (
    <div className="mt-6 flex flex-col gap-4 rounded-tarjeta border border-line bg-raised p-5">
      <p className="font-display font-semibold text-ink">Conecta tu número de WhatsApp Business</p>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-body">
        <li>Tu número sigue en tu teléfono: IAxTi se conecta al lado, sin cambiarlo.</li>
        <li>Te mandamos un enlace de Meta para autorizarlo. Toma unos minutos.</li>
        <li>Desde ese momento, los mensajes llegan a tu bandeja y tu asistente puede contestar.</li>
      </ol>
      <span className="flex flex-wrap gap-2">
        <a
          href="mailto:soporte@voxtilabs.cl?subject=Conectar%20mi%20WhatsApp%20a%20IAxTi"
          className="pulso-button inline-flex h-10 items-center rounded-boton bg-action px-4 text-sm font-medium text-white hover:bg-action-hover"
        >
          Pedir la conexión
        </a>
      </span>
      <p className="text-xs text-muted">Hoy la conexión la hace el equipo de IAxTi contigo, el mismo día.</p>
    </div>
  );
}

/** El detalle de las cuentas de un tipo: estado, número, diagnóstico y prueba. */
function DetalleDeCanales({
  canales,
  vacio,
  onCambio,
  onAviso,
}: {
  canales: CanalDto[];
  vacio?: React.ReactNode;
  onCambio: () => Promise<void>;
  onAviso: (texto: string | null) => void;
}) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [desconectando, setDesconectando] = useState<string | null>(null);

  async function reactivar(numberId: string) {
    if (!session || !tenant) return;
    onAviso(null);
    try {
      await apiFetch(config, session, tenant, `/whatsapp/numbers/${numberId}/resume`, { method: 'POST' });
      await onCambio();
    } catch (err) {
      onAviso(mensajeDeError(err));
    }
  }

  // Desconectar ARCHIVA (#600): libera el cupo del plan y el historial se
  // queda. Apaga los envíos del negocio, y eso se nota en la cara del cliente.
  async function desconectar(accountId: string) {
    if (!session || !tenant) return;
    onAviso(null);
    setDesconectando(accountId);
    try {
      await apiFetch(config, session, tenant, `/channels/${accountId}/desconectar`, { method: 'POST' });
      await onCambio();
    } catch (err) {
      onAviso(mensajeDeError(err));
    } finally {
      setDesconectando(null);
    }
  }

  if (canales.length === 0) return <>{vacio}</>;

  return (
    <ul className="mt-6 flex flex-col gap-4">
      {canales.map((canal) => {
        const estado = ESTADO_CANAL[canal.state];
        return (
          <li key={canal.id} className="rounded-tarjeta border border-line bg-raised p-5">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 font-display font-semibold text-ink">{canal.name}</span>
              <Badge role={estado.role}>{estado.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{estado.ayuda}</p>

            {canal.numbers.map((n) => {
              const calidad = n.quality ? CALIDAD[n.quality] : null;
              return (
                <div key={n.id} className="mt-4 rounded-campo border border-line bg-bg p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="dato text-ink">{n.displayPhone ?? n.phoneNumberId}</span>
                    {calidad && <Badge role={calidad.role}>{calidad.label}</Badge>}
                    {n.messagingLimit && <span className="dato text-muted">{n.messagingLimit}</span>}
                  </div>
                  {calidad && <p className="mt-2 text-sm text-body">{calidad.ayuda}</p>}
                  {n.businessPausedAt && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Badge role="warn">Envíos del negocio pausados</Badge>
                      <Button variant="secundario" size="chico" onClick={() => void reactivar(n.id)}>
                        Reactivar envíos
                      </Button>
                      <span className="text-xs text-muted">No se reactivan solos: tú decides cuándo.</span>
                    </div>
                  )}
                </div>
              );
            })}

            <Diagnostico accountId={canal.id} />
            {canal.kind !== 'webchat' && <ProbarEnvio key={`${tenant}:${session?.access_token}:${canal.id}`} accountId={canal.id} kind={canal.kind} />}

            {/* Desconectar (#600): solo WhatsApp tiene cupo de plan. */}
            {canal.kind === 'whatsapp' && canal.state !== 'disconnected' && (
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                <Button variant="fantasma" size="chico" disabled={desconectando === canal.id} onClick={() => void desconectar(canal.id)}>
                  {desconectando === canal.id ? 'Desconectando…' : 'Desconectar canal'}
                </Button>
                <span className="text-xs text-muted">Libera el cupo de tu plan. Las conversaciones se quedan.</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** El webchat (#46): crear el widget, encenderlo o apagarlo, y su snippet. */
function DetalleDelWebchat({
  widgets,
  onCambio,
  onAviso,
}: {
  widgets: WidgetDto[];
  onCambio: () => Promise<void>;
  onAviso: (texto: string | null) => void;
}) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [dominio, setDominio] = useState('');

  return (
    <div className="mt-6">
      <Formulario
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!session || !tenant || !dominio.trim()) return;
          void apiFetch(config, session, tenant, '/webchat/widgets', {
            method: 'POST',
            body: JSON.stringify({ allowedDomain: dominio.trim() }),
          })
            .then(() => {
              setDominio('');
              return onCambio();
            })
            .catch((err) => onAviso(mensajeDeError(err)));
        }}
      >
        <Input
          aria-label="Dominio del sitio"
          placeholder="tunegocio.cl"
          className="h-9 w-56 text-sm"
          value={dominio}
          onChange={(e) => setDominio(e.target.value)}
        />
        <Button type="submit" variant="secundario" size="chico" disabled={!dominio.trim()}>
          Crear widget
        </Button>
      </Formulario>
      {widgets.length === 0 && (
        <EstadoVacio
          compacto
          className="mt-4"
          titulo="Todavía no tienes el chat en tu sitio"
          descripcion="Lo creas con el dominio de tu sitio y pegas el código que te damos."
          pideleAIAxTi="Créame un widget de chat para el dominio de mi sitio web"
          accion={{
            etiqueta: 'Escribir el dominio',
            onClick: () => document.querySelector<HTMLElement>('[aria-label="Dominio del sitio"]')?.focus(),
          }}
        />
      )}
      <ul className="mt-4 flex flex-col gap-3">
        {widgets.map((w) => (
          <li key={w.id} className="rounded-campo border border-line bg-raised p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{w.name}</span>
                <span className="dato text-muted">{w.allowedDomain}</span>
              </span>
              <Badge role={w.active ? 'good' : 'neutral'}>{w.active ? 'Activo' : 'Apagado'}</Badge>
              <Button
                variant="fantasma"
                size="chico"
                onClick={() => {
                  if (!session || !tenant) return;
                  // El `catch` hace que un rechazo se vea (#588, punto 4).
                  void apiFetch(config, session, tenant, `/webchat/widgets/${w.id}/toggle`, {
                    method: 'POST',
                    body: JSON.stringify({ active: !w.active }),
                  })
                    .then(onCambio)
                    .catch((err) => onAviso(mensajeDeError(err)));
                }}
              >
                {w.active ? 'Apagar' : 'Encender'}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">Pega esto antes de {'</body>'} en tu sitio (el historial queda aunque lo apagues):</p>
            <pre className="dato mt-1 overflow-x-auto rounded-campo bg-rest p-3 text-xs text-ink">
              {`<script src="${typeof window !== 'undefined' ? window.location.origin : ''}/webchat.js" data-widget="${w.id}" async></script>`}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
