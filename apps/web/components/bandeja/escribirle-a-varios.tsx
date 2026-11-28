'use client';

import { useRef, useState } from 'react';
import {
  Badge, Button, Dialog, DialogContent, DialogTitle, DialogDescription,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
  toast, useSession, type BadgeRole,
} from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import { QuienLoHizo } from '../quien-lo-hizo';
import { apiFetch, avisoDe, type Aviso } from '../../lib/api';

/**
 * Escribirle a varios desde la bandeja (#1247).
 *
 * Al cerrar el stand: el mismo texto para todos los que conversaron hoy. Dos
 * pasos OBLIGATORIOS antes de mandar — el texto con su filtro, y la previa que
 * dice a quién le llega y a quién no y por qué— porque un WhatsApp no se
 * deshace.
 *
 * El botón de enviar NO EXISTE hasta que la previa está en pantalla: es la
 * única forma de que el conteo se mire siempre.
 */

interface PreviaDto {
  id: string;
  texto: string;
  total: number;
  muestra: Array<{ conversationId: string; nombre: string | null; telefono: string }>;
  fuera: Array<{ motivo: string; n: number }>;
  truncado: boolean;
  enSilencio: boolean;
}

interface DestinatarioDto {
  conversationId: string;
  nombre: string | null;
  telefono: string | null;
  deliveryStatus: string | null;
  error: string | null;
  excluido: string | null;
  intentos: number;
}

interface ResultadoDto {
  id: string;
  texto: string;
  estado: 'previa' | 'enviada';
  total: number | null;
  /** Quién apretó enviar (#697): «¿quién mandó esto a 31 personas?». */
  creadaPor: { userId: string; nombre: string | null; enElEquipo: boolean | null } | null;
  createdAt: string;
  enviadaAt: string | null;
  destinatarios: DestinatarioDto[];
}

/**
 * Cómo se dice cada motivo, en singular y en plural (#1247).
 *
 * Con el verbo adentro, el número manda en los dos lados: «1 conversación
 * que pidió», «2 conversaciones que pidieron». La primera versión pluralizaba
 * el sustantivo con el total y dejaba el verbo fijo, y la previa decía
 * «1 conversaciones que pidió no recibir mensajes».
 */
const MOTIVOS: Record<string, [uno: string, varios: string]> = {
  'ventana cerrada': ['con la ventana de 24 h cerrada', 'con la ventana de 24 h cerrada'],
  'se dio de baja': ['que pidió no recibir mensajes', 'que pidieron no recibir mensajes'],
  'es del equipo': ['que es del equipo', 'que son del equipo'],
};

const ENTREGA: Record<string, { label: string; rol: BadgeRole }> = {
  queued: { label: 'En cola', rol: 'neutral' },
  sent: { label: 'Enviado', rol: 'info' },
  delivered: { label: 'Entregado', rol: 'good' },
  read: { label: 'Leído', rol: 'good' },
  failed: { label: 'No llegó', rol: 'bad' },
};

const ESTADOS: Array<{ valor: string; label: string }> = [
  { valor: 'new', label: 'Nuevas' },
  { valor: 'open', label: 'Abiertas' },
  { valor: 'pending', label: 'Pendientes' },
  { valor: 'snoozed', label: 'Pospuestas' },
];

type Vista = 'redactar' | 'previa' | 'resultado';

export function EscribirleAVarios({
  abierto,
  onCerrar,
  etiquetas,
  onTermino,
}: {
  abierto: boolean;
  onCerrar: () => void;
  /** Las etiquetas del negocio, del arranque del shell. */
  etiquetas: Array<{ id: string; name: string }>;
  /** Para refrescar la bandeja cuando el envío ya salió. */
  onTermino?: () => void;
}) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [vista, setVista] = useState<Vista>('redactar');
  const [texto, setTexto] = useState('');
  const [estado, setEstado] = useState('');
  const [etiquetaId, setEtiquetaId] = useState('');
  const [previa, setPrevia] = useState<PreviaDto | null>(null);
  const [resultado, setResultado] = useState<ResultadoDto | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [ocupado, setOcupado] = useState(false);
  /** Una llave por envío: el doble clic no manda dos veces los mismos WhatsApp. */
  const llaves = useRef(new Map<string, string>());

  function alAbrirDeNuevo() {
    setVista('redactar');
    setTexto('');
    setEstado('');
    setEtiquetaId('');
    setPrevia(null);
    setResultado(null);
    setAviso(null);
  }

  async function verPrevia() {
    if (!session || !tenant || !texto.trim() || ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      const p = await apiFetch<PreviaDto>(config, session, tenant, '/conversations/difusion/previa', {
        method: 'POST',
        body: JSON.stringify({
          texto: texto.trim(),
          filtro: {
            ...(estado ? { estado } : {}),
            ...(etiquetaId ? { etiquetaId } : {}),
          },
        }),
      });
      setPrevia(p);
      setVista('previa');
    } catch (err) {
      setAviso(avisoDe(err));
    } finally {
      setOcupado(false);
    }
  }

  async function enviar() {
    if (!session || !tenant || !previa || ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      const llave = llaves.current.get(previa.id) ?? crypto.randomUUID();
      llaves.current.set(previa.id, llave);
      await apiFetch(config, session, tenant, '/conversations/difusion', {
        method: 'POST',
        body: JSON.stringify({ previaId: previa.id }),
        headers: { 'Idempotency-Key': llave },
      });
      await traerResultado(previa.id);
      toast.success(`Envío en marcha para ${previa.total} ${previa.total === 1 ? 'persona' : 'personas'}`);
      onTermino?.();
    } catch (err) {
      setAviso(avisoDe(err));
    } finally {
      setOcupado(false);
    }
  }

  async function traerResultado(id: string) {
    const r = await apiFetch<ResultadoDto>(config, session!, tenant!, `/conversations/difusion/${id}`);
    setResultado(r);
    setVista('resultado');
  }

  async function reintentar() {
    if (!session || !tenant || !resultado || ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, `/conversations/difusion/${resultado.id}/reintentar`, {
        method: 'POST',
      });
      await traerResultado(resultado.id);
    } catch (err) {
      setAviso(avisoDe(err));
    } finally {
      setOcupado(false);
    }
  }

  const fallados = resultado?.destinatarios.filter((d) => d.deliveryStatus === 'failed') ?? [];
  const llegaron = resultado?.destinatarios.filter(
    (d) => d.deliveryStatus && ['sent', 'delivered', 'read'].includes(d.deliveryStatus),
  ) ?? [];
  const enCola = resultado?.destinatarios.filter((d) => d.deliveryStatus === 'queued') ?? [];
  const afuera = resultado?.destinatarios.filter((d) => d.excluido) ?? [];

  return (
    <Dialog
      open={abierto}
      onOpenChange={(abiertoAhora) => {
        if (!abiertoAhora) onCerrar();
        else alAbrirDeNuevo();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>Escribirle a varios</DialogTitle>
        <DialogDescription>
          El mismo texto para las conversaciones de WhatsApp que escribieron en las últimas 24 horas.
        </DialogDescription>

        {aviso && (
          <p role="alert" className="mt-3 rounded-campo bg-bad-soft px-3 py-2 text-dato text-bad-text">
            {aviso.texto}
            {aviso.rastro && <span className="dato mt-1 block text-rotulo">{aviso.rastro}</span>}
          </p>
        )}

        {vista === 'redactar' && (
          <div className="mt-4 space-y-4">
            <label className="block text-sm font-medium">
              El mensaje
              <Textarea
                className="mt-1"
                rows={4}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Gracias por escribirnos. Acá quedamos en contacto"
              />
            </label>
            <fieldset className="space-y-3 rounded-tarjeta border border-line p-4">
              <legend className="px-2 font-semibold text-ink">A quién le llega</legend>
              <label className="block text-sm">
                Estado de la conversación
                <Select value={estado} onValueChange={setEstado}>
                  <SelectTrigger className="mt-1 w-full" aria-label="Estado de la conversación">
                    <SelectValue placeholder="Todas las de la bandeja" />
                  </SelectTrigger>
                  <SelectContent>
                    {ESTADOS.map((e) => (
                      <SelectItem key={e.valor} value={e.valor}>{e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {etiquetas.length > 0 && (
                <label className="block text-sm">
                  Con la etiqueta
                  <Select value={etiquetaId} onValueChange={setEtiquetaId}>
                    <SelectTrigger className="mt-1 w-full" aria-label="Con la etiqueta">
                      <SelectValue placeholder="Cualquier etiqueta" />
                    </SelectTrigger>
                    <SelectContent>
                      {etiquetas.map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              <p className="text-sm text-muted">
                Quedan fuera quienes se dieron de baja, los del equipo y las conversaciones cuya
                ventana de 24 horas ya cerró.
              </p>
            </fieldset>
            <Button
              className="w-full"
              disabled={ocupado || !texto.trim()}
              onClick={() => void verPrevia()}
            >
              {ocupado ? 'Contando' : 'Ver a quién le llega'}
            </Button>
          </div>
        )}

        {vista === 'previa' && previa && (
          <div className="mt-4 space-y-4">
            <p>
              <strong className="font-mono text-2xl text-ink tabular-nums">{previa.total}</strong>{' '}
              {previa.total === 1 ? 'persona va a recibir' : 'personas van a recibir'} este texto
            </p>
            <blockquote className="whitespace-pre-wrap break-words rounded-campo border border-line bg-raised p-4 text-body">
              {previa.texto}
            </blockquote>
            {previa.muestra.length > 0 && (
              <div>
                <p className="text-sm font-medium">Por ejemplo</p>
                <ul className="mt-1">
                  {previa.muestra.map((m) => (
                    <li key={m.conversationId} className="flex justify-between gap-3 border-b border-line py-2 text-dato">
                      <span className="min-w-0 truncate">{m.nombre ?? 'Contacto sin nombre'}</span>
                      <span className="font-mono text-muted">{m.telefono}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {previa.fuera.length > 0 && (
              <div>
                <p className="text-sm font-medium">Quedan fuera</p>
                <ul className="mt-1 space-y-1 text-dato text-body">
                  {previa.fuera.map((f) => (
                    <li key={f.motivo}>
                      <span className="font-mono tabular-nums">{f.n}</span>{' '}
                      {f.n === 1 ? 'conversación' : 'conversaciones'}{' '}
                      {MOTIVOS[f.motivo]?.[f.n === 1 ? 0 : 1] ?? f.motivo}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {previa.enSilencio && (
              <p className="rounded-campo bg-warn-soft px-3 py-2 text-dato text-warn-text">
                Estás en horario de silencio: el envío queda en la cola y sale cuando termine.
              </p>
            )}
            {previa.truncado && (
              <p className="rounded-campo bg-warn-soft px-3 py-2 text-dato text-warn-text">
                El filtro alcanza a más conversaciones de las que se pueden escribir de una vez: van
                las {previa.total} más recientes. Para el resto, estrecha el filtro y repite.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                className="sm:flex-1"
                disabled={ocupado || previa.total === 0}
                onClick={() => void enviar()}
              >
                {ocupado ? 'Enviando' : `Enviar a ${previa.total}`}
              </Button>
              <Button variant="secundario" disabled={ocupado} onClick={() => setVista('redactar')}>
                Volver a editar
              </Button>
            </div>
          </div>
        )}

        {vista === 'resultado' && resultado && (
          <div className="mt-4 space-y-4">
            <QuienLoHizo
              accion="Enviada"
              quien={resultado.creadaPor}
              cuando={resultado.enviadaAt ?? resultado.createdAt}
            />
            <div className="flex flex-wrap gap-6">
              {[
                ['Recibieron', llegaron.length, 'good'],
                ['En cola', enCola.length, 'info'],
                ['No llegó', fallados.length, 'bad'],
                ['Quedaron fuera', afuera.length, 'neutral'],
              ].map(([label, n]) => (
                <p key={label as string}>
                  <span className="block text-sm text-muted">{label}</span>
                  <strong className="font-mono text-2xl text-ink tabular-nums">{n as number}</strong>
                </p>
              ))}
            </div>
            {resultado.destinatarios.length > 0 && (
              <ul className="max-h-64 overflow-y-auto">
                {resultado.destinatarios.map((d) => (
                  <li key={d.conversationId} className="border-b border-line py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-dato">{d.nombre ?? d.telefono ?? 'Contacto sin nombre'}</span>
                      {d.excluido ? (
                        <span className="shrink-0 text-rotulo text-muted">{MOTIVOS[d.excluido]?.[0] ?? d.excluido}</span>
                      ) : (
                        <Badge role={ENTREGA[d.deliveryStatus ?? 'queued']?.rol ?? 'neutral'}>
                          {ENTREGA[d.deliveryStatus ?? 'queued']?.label ?? d.deliveryStatus}
                        </Badge>
                      )}
                    </div>
                    {d.error && <p className="mt-0.5 text-rotulo text-bad-text">{d.error}</p>}
                    {d.intentos > 1 && !d.excluido && (
                      <p className="mt-0.5 text-rotulo text-muted">{d.intentos} intentos</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              {fallados.length > 0 ? (
                <Button className="sm:flex-1" disabled={ocupado} onClick={() => void reintentar()}>
                  {ocupado ? 'Reintentando' : `Reintentar los ${fallados.length} fallidos`}
                </Button>
              ) : (
                <Button className="sm:flex-1" onClick={onCerrar}>Listo</Button>
              )}
              <Button
                variant="secundario"
                disabled={ocupado}
                onClick={() => void traerResultado(resultado.id).catch((err: unknown) => setAviso(avisoDe(err)))}
              >
                Actualizar
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
