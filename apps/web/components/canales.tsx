'use client';

import { AvisoResultado, EncabezadoDePagina, EstadoVacio, Formulario } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import type { BadgeRole } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe, type Aviso } from '../lib/api';
import { ConectarCanalesMeta } from './conectar-canales-meta';

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

/** Un emisor del proyecto de la llave de este canal (#600). */
interface EmisorDto {
  id: string;
  name: string | null;
  channels: string[];
  /** Si tiene ESTE canal encendido. El que no, no se puede elegir. */
  sirve: boolean;
  /** El que la cuenta usa hoy. */
  actual: boolean;
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
      setDetalle((err as Error).message);
    }
  }

  return (
    <section className="mt-8 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
      <h2 className="text-lg font-bold text-ink">Probar sin número real</h2>
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

/**
 * Reapuntar el canal a otro emisor, y desconectarlo (#600).
 *
 * De dónde sale: cambiar la llave de Zavu de un canal conectado —de prueba a
 * producción— puede dejar el `senderId` guardado apuntando a un emisor que en
 * el proyecto de la llave nueva **no existe**. Desde #591 el diagnóstico lo
 * dice, pero decirlo no era arreglarlo: no había ninguna ruta para reapuntar ni
 * para desconectar, y el único camino era entrar a la base a mano. Para algo que
 * un ADMIN tiene que poder hacer en su pantalla.
 *
 * Los emisores se piden **a pedido** y no al cargar la pantalla: es una llamada
 * al proveedor, y la pregunta se hace cuando algo hay que cambiar, no en cada
 * visita.
 *
 * Los que no sirven se MUESTRAN, deshabilitados y con el motivo. Filtrarlos
 * dejaría una lista vacía sin explicación —«no hay emisores»— cuando lo que pasa
 * es que existen y les falta este canal encendido en Zavu, que se arregla allá y
 * no acá.
 */
function CambiarEmisor({
  accountId,
  kind,
  onListo,
  onError,
}: {
  accountId: string;
  kind: string;
  onListo: () => Promise<void>;
  onError: (mensaje: string) => void;
}) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [emisores, setEmisores] = useState<EmisorDto[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [cambiando, setCambiando] = useState<string | null>(null);

  const pedirEmisores = async () => {
    if (!session || !tenant) return;
    setCargando(true);
    onError('');
    try {
      setEmisores(
        await apiFetch<EmisorDto[]>(config, session, tenant, `/channels/${accountId}/emisores`),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No pudimos pedirle los emisores al proveedor.');
    } finally {
      setCargando(false);
    }
  };

  const cambiar = async (senderId: string) => {
    if (!session || !tenant) return;
    setCambiando(senderId);
    onError('');
    try {
      await apiFetch(config, session, tenant, `/channels/${accountId}/emisor`, {
        method: 'POST',
        body: JSON.stringify({ senderId }),
      });
      setEmisores(null);
      await onListo();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No pudimos cambiar el emisor.');
    } finally {
      setCambiando(null);
    }
  };

  return (
    <div className="mt-3">
      {/* Con cero emisores este botón decía lo MISMO que la acción del panel
          de abajo, y dos controles con el mismo nombre en una vista son
          ambiguos —para un lector de pantalla y para el e2e estricto—. Ahí la
          acción la ofrece el panel, que además explica qué es un emisor. */}
      {!(emisores !== null && emisores.length === 0) && (
        <Button variant="secundario" size="chico" onClick={() => void pedirEmisores()} disabled={cargando}>
          {cargando ? 'Preguntando al proveedor…' : emisores ? 'Pedir la lista de nuevo' : 'Cambiar el emisor'}
        </Button>
      )}
      {emisores !== null && emisores.length === 0 && (
        // Era un párrafo que decía dónde se conectan y dejaba a la persona
        // sin saber qué sigue acá (#588). El emisor es el número de WhatsApp:
        // sin él, el canal no existe.
        <EstadoVacio
          compacto
          className="mt-2"
          titulo="Este proyecto no tiene ningún número conectado"
          descripcion="El emisor es el número de WhatsApp con el que tu negocio contesta. Se conecta en Zavu aceptando la invitación, y al volver acá aparece en esta lista para elegirlo."
          accion={{ etiqueta: 'Pedir la lista de nuevo', onClick: () => void pedirEmisores() }}
        />
      )}
      {emisores !== null && emisores.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {emisores.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 rounded-campo border border-line bg-bg p-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{e.name ?? 'Sin nombre'}</span>
                <span className="dato text-muted">{e.id}</span>
              </span>
              {e.actual && <Badge role="good">El de ahora</Badge>}
              {!e.sirve && <Badge role="neutral">Sin {kind}</Badge>}
              {!e.actual && e.sirve && (
                <Button
                  variant="secundario"
                  size="chico"
                  disabled={cambiando !== null}
                  onClick={() => void cambiar(e.id)}
                >
                  {cambiando === e.id ? 'Cambiando…' : 'Apuntar acá'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {emisores?.some((e) => !e.sirve) && (
        <p className="mt-2 text-xs text-muted">
          Los marcados «Sin {kind}» existen en el proyecto pero no tienen ese canal encendido. Eso se
          activa en Zavu; acá no se puede forzar, porque un emisor sin el canal no manda nada.
        </p>
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

function CanalesDelNegocio() {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [canales, setCanales] = useState<CanalDto[] | null>(null);
  const [widgets, setWidgets] = useState<WidgetDto[]>([]);
  const [dominio, setDominio] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);

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
      setAviso((err as Error).message);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function reactivar(numberId: string) {
    if (!session || !tenant) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, `/whatsapp/numbers/${numberId}/resume`, { method: 'POST' });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  // Desconectar ARCHIVA (#600): libera el cupo del plan y el historial se
  // queda. Se pregunta antes porque apaga los envíos del negocio, y eso se nota
  // en la cara del cliente que escribe y no recibe respuesta.
  const [desconectando, setDesconectando] = useState<string | null>(null);
  async function desconectar(accountId: string) {
    if (!session || !tenant) return;
    setAviso(null);
    setDesconectando(accountId);
    try {
      await apiFetch(config, session, tenant, `/channels/${accountId}/desconectar`, { method: 'POST' });
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setDesconectando(null);
    }
  }

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  return (
    <div className="max-w-2xl">
      <EncabezadoDePagina
        rotulo="CANALES"
        titulo="Tus canales conectados"
      />
      <ConectarCanalesMeta onConectado={(cuenta) => setCanales((actual) => [
        ...(actual ?? []).filter((c) => c.id !== cuenta.id), { ...cuenta, numbers: [] },
      ])} />

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}

      {canales === null ? (
        <div className="mt-6 flex flex-col gap-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : canales.length === 0 ? (
        // Antes esta pantalla remitía a la conexión guiada y no ofrecía
        // ninguna acción: un negocio sin canales es un negocio que no recibe
        // mensajes, y acá era donde se quedaba parado (#509).
        <EstadoVacio
          compacto
          className="mt-6"
          titulo="Todavía no hay canales"
          descripcion="Al conectar tu número de WhatsApp aparecerá aquí con su estado y la calidad que Meta le asigna. La puesta en marcha te va guiando paso a paso."
          accion={{ etiqueta: 'Ir a la puesta en marcha', href: '/' }}
          pideleAIAxTi="Quiero conectar mi WhatsApp, ¿qué necesito?"
        />
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {canales.map((canal) => {
            const estado = ESTADO_CANAL[canal.state];
            return (
              <li key={canal.id} className="pulso-panel rounded-tarjeta border border-line bg-raised p-6">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-display font-bold text-ink">{canal.name}</span>
                    <span className="text-sm text-muted">{canal.kind}</span>
                  </span>
                  <Badge role={estado.role}>{estado.label}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted">{estado.ayuda}</p>

                <Diagnostico accountId={canal.id} />

                {/* Probar el envío (#587): junto al diagnóstico, porque es la
                    pregunta siguiente. El diagnóstico dice cómo está
                    configurado; esto dice si de verdad sale un mensaje. */}
                {canal.kind !== 'webchat' && <ProbarEnvio key={`${tenant}:${session?.access_token}:${canal.id}`} accountId={canal.id} kind={canal.kind} />}

                {/* Reapuntar y desconectar (#600). Solo en WhatsApp: es el
                    único canal con emisor del proveedor y con cupo de plan. */}
                {canal.kind === 'whatsapp' && (
                  <>
                    <CambiarEmisor
                      accountId={canal.id}
                      kind={canal.kind}
                      onListo={cargar}
                      onError={(m) => setAviso(m || null)}
                    />
                    {canal.state !== 'disconnected' && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <Button
                          variant="fantasma"
                          size="chico"
                          disabled={desconectando === canal.id}
                          onClick={() => void desconectar(canal.id)}
                        >
                          {desconectando === canal.id ? 'Desconectando…' : 'Desconectar canal'}
                        </Button>
                        <span className="text-xs text-muted">
                          Libera el cupo de tu plan. Las conversaciones se quedan.
                        </span>
                      </div>
                    )}
                  </>
                )}

                {canal.numbers.map((n) => {
                  const calidad = n.quality ? CALIDAD[n.quality] : null;
                  return (
                    <div key={n.id} className="mt-4 rounded-campo border border-line bg-bg p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="dato text-ink">{n.displayPhone ?? n.phoneNumberId}</span>
                        {calidad && <Badge role={calidad.role}>{calidad.label}</Badge>}
                        {n.messagingLimit && (
                          <span className="dato text-muted">{n.messagingLimit}</span>
                        )}
                      </div>
                      {calidad && <p className="mt-2 text-sm text-body">{calidad.ayuda}</p>}
                      {n.businessPausedAt && (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Badge role="warn">Envíos del negocio pausados</Badge>
                          <Button
                            variant="secundario"
                            size="chico"
                            onClick={() => void reactivar(n.id)}
                          >
                            Reactivar envíos
                          </Button>
                          <span className="text-xs text-muted">
                            No se reactivan solos: tú decides cuándo.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      )}

      {/* Webchat (#46): el widget propio y su snippet de instalación. */}
      <section className="mt-10">
        <p className="rotulo">Chat del sitio</p>
        <h2 className="mt-1 text-lg font-bold text-ink">Webchat</h2>
        <p className="mt-1 max-w-prose text-sm text-body">
          Un chat en tu página que cae en la misma bandeja. Sin número.
        </p>
        <Formulario
          className="mt-4 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!session || !tenant || !dominio.trim()) return;
            void apiFetch(config, session, tenant, '/webchat/widgets', {
              method: 'POST',
              body: JSON.stringify({ allowedDomain: dominio.trim() }),
            })
              .then(() => {
                setDominio('');
                return cargar();
              })
              .catch((err) => setAviso((err as Error).message));
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
          // Con cero widgets esta sección quedaba en blanco debajo de un
          // formulario que nadie sabe para qué es (#588/#1068). El
          // formulario está justo arriba, así que acá va el para qué.
          <EstadoVacio
            compacto
            className="mt-4"
            titulo="Todavía no tienes el chat en tu sitio"
            descripcion="Lo creas con el dominio de tu sitio y pegas el código que te damos."
            pideleAIAxTi="Créame un widget de chat para el dominio de mi sitio web"
            accion={{
              etiqueta: 'Crear el primero',
              onClick: () => {
                const campo = document.querySelector<HTMLElement>('[aria-label="Dominio del sitio"]');
                campo?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                campo?.focus();
              },
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
                    // El `catch` es lo que hace que un rechazo se vea
                    // (#588, punto 4). `apiFetch` LANZA con un 4xx o un 5xx,
                    // así que sin esto la promesa quedaba rechazada sin dueño:
                    // `cargar()` no corría, la insignia seguía diciendo
                    // «Activo» y nada explicaba por qué. Alguien aprieta
                    // «Apagar», el widget sigue encendido y el único mensaje
                    // está en la consola del navegador.
                    void apiFetch(config, session, tenant, `/webchat/widgets/${w.id}/toggle`, {
                      method: 'POST',
                      body: JSON.stringify({ active: !w.active }),
                    })
                      .then(cargar)
                      .catch((err) => setAviso((err as Error).message));
                  }}
                >
                  {w.active ? 'Apagar' : 'Encender'}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted">
                Pega esto antes de {'</body>'} en tu sitio (el historial queda aunque lo apagues):
              </p>
              <pre className="dato mt-1 overflow-x-auto rounded-campo bg-rest p-3 text-xs text-ink">
{`<script src="${typeof window !== 'undefined' ? window.location.origin : ''}/webchat.js" data-widget="${w.id}" async></script>`}
              </pre>
            </li>
          ))}
        </ul>
      </section>

      <ProbarSinNumero />
    </div>
  );
}
