'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, fmtClp } from '../lib/api';

/**
 * «No mover» como valor del desplegable.
 *
 * Radix no acepta `value=""` en un SelectItem, y `null` es exactamente lo que
 * hay que mandar para apagarlo: este centinela hace el viaje de ida y vuelta.
 */
const SIN_MOVER = '__sin_mover__';

// Pagos (#60/#61, SPEC §17): proveedores con credenciales POR REFERENCIA
// (aquí solo se escribe el NOMBRE de la variable de entorno) y los links
// con su estado. Montos SIEMPRE en mono.

interface ProveedorDto {
  id: string;
  kind: string;
  name: string;
  credentialRef: string;
  mode: 'test' | 'live';
  active: boolean;
}

interface LinkDto {
  id: string;
  amountClp: number;
  concept: string;
  status: 'created' | 'sent' | 'paid' | 'expired' | 'cancelled';
  url: string | null;
  createdAt: string;
  paidAt: string | null;
}

const KINDS = [
  { value: 'flow', label: 'Flow' },
  { value: 'webpay', label: 'Webpay (pronto)' },
  { value: 'mercadopago', label: 'Mercado Pago (pronto)' },
  { value: 'simulado', label: 'Simulador (staging)' },
];

const ESTADO_LINK: Record<LinkDto['status'], { label: string; role: 'good' | 'neutral' | 'warn' | 'action' }> = {
  created: { label: 'Creado', role: 'neutral' },
  sent: { label: 'Enviado', role: 'action' },
  paid: { label: 'Pagado', role: 'good' },
  expired: { label: 'Vencido', role: 'warn' },
  cancelled: { label: 'Cancelado', role: 'neutral' },
};

export function Pagos() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [proveedores, setProveedores] = useState<ProveedorDto[] | null>(null);
  const [links, setLinks] = useState<LinkDto[]>([]);
  const [kind, setKind] = useState('flow');
  const [nombre, setNombre] = useState('');
  const [credRef, setCredRef] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState<string | null>(null);
  // El tope del vendedor (#535): `null` es «sin tope», y es distinto de 0.
  const [tope, setTope] = useState<number | null>(null);
  const [topeEscrito, setTopeEscrito] = useState('');
  const [guardandoTope, setGuardandoTope] = useState(false);
  // La etapa a la que se mueve la oportunidad al pagar (#536). `''` es «no
  // mover»: hay negocios que prefieren hacerlo a mano.
  const [etapaPagado, setEtapaPagado] = useState(SIN_MOVER);
  const [etapasDisponibles, setEtapasDisponibles] = useState<string[]>([]);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [nuevosProveedores, nuevosLinks, ajustes] = await Promise.all([
        apiFetch<ProveedorDto[]>(config, session, tenant, '/payments/providers'),
        apiFetch<LinkDto[]>(config, session, tenant, '/payments/links'),
        // Sin `tenant.settings` esto responde 403, y no es un error que mostrar:
        // quien atiende ve la pantalla sin el campo del tope, que no es suyo.
        apiFetch<{
          maxLinkClpUser: number | null;
          paidStageName: string | null;
          etapasDisponibles: string[];
        }>(config, session, tenant, '/payments/ajustes').catch(() => null),
      ]);
      setProveedores(nuevosProveedores);
      setLinks(nuevosLinks);
      if (ajustes) {
        setTope(ajustes.maxLinkClpUser);
        setTopeEscrito(ajustes.maxLinkClpUser === null ? '' : String(ajustes.maxLinkClpUser));
        setEtapaPagado(ajustes.paidStageName ?? SIN_MOVER);
        setEtapasDisponibles(ajustes.etapasDisponibles ?? []);
      }
    } catch (err) {
      setAviso((err as Error).message);
      setProveedores([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  /**
   * Guarda el tope del vendedor (#535).
   *
   * Vacío es `null` —sin tope—, y es distinto de 0: un tope de cero dejaría al
   * vendedor sin poder cobrar nada y en la pantalla se vería igual que «sin
   * tope», porque los dos son cero. El servidor rechaza el 0 y acá se manda
   * null.
   */
  const guardarTope = async () => {
    if (!session || !tenant || guardandoTope) return;
    const limpio = topeEscrito.replace(/\D/g, '');
    setGuardandoTope(true);
    try {
      const r = await apiFetch<{
        maxLinkClpUser: number | null;
        paidStageName: string | null;
        enEmbudos: string[];
        faltaEn: string[];
      }>(
        config,
        session,
        tenant,
        '/payments/ajustes',
        {
          method: 'PUT',
          body: JSON.stringify({
            maxLinkClpUser: limpio ? Number(limpio) : null,
            paidStageName: etapaPagado === SIN_MOVER ? null : etapaPagado,
          }),
        },
      );
      setTope(r.maxLinkClpUser);
      setTopeEscrito(r.maxLinkClpUser === null ? '' : String(r.maxLinkClpUser));
      // Cuando el negocio tiene dos embudos y la etapa está en uno solo, el
      // servidor lo dice al guardar: descubrirlo cuando el otro no se movió es
      // descubrirlo tarde.
      setAviso(
        r.faltaEn?.length
          ? `Guardado. Ojo: "${r.paidStageName}" no existe en ${r.faltaEn.join(' ni ')}, así que ahí la oportunidad no se va a mover sola.`
          : null,
      );
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setGuardandoTope(false);
    }
  };

  const cancelar = async (l: LinkDto) => {
    if (!session || !tenant || cancelando) return;
    setCancelando(l.id);
    try {
      await apiFetch(config, session, tenant, `/payments/links/${l.id}/cancel`, { method: 'POST' });
      setAviso(null);
      await cargar();
    } catch (err) {
      // Un link ya pagado no se cancela: eso es una devolución, y la hace
      // el proveedor. El servidor lo dice con su propio mensaje.
      setAviso((err as Error).message);
    } finally {
      setCancelando(null);
    }
  };

  if (!tenant) return <p className="text-muted">Elige un negocio en el selector.</p>;

  const conectar = async () => {
    if (!session) return;
    setAviso(null);
    try {
      await apiFetch(config, session, tenant, '/payments/providers', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: nombre,
          credentialRef: credRef,
          webhookSecretRef: secretRef || undefined,
          mode: 'test',
        }),
      });
      setNombre('');
      setCredRef('');
      setSecretRef('');
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="max-w-2xl">
      <EncabezadoDePagina
        rotulo="PAGOS"
        titulo="Cobra con links desde el chat"
      />
      <p className="mt-2 text-sm text-muted">
        Conecta tu pasarela y el equipo cobra sin salir de la conversación. Las credenciales viven
        en el servidor: aquí solo va el <span className="dato">NOMBRE</span> de la variable de
        entorno que las guarda — nunca la credencial. En este ambiente todo corre en modo test.
      </p>

      <div className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Tope por cobro</span>
        <p className="mt-2 text-sm text-body">
          Hasta cuánto puede cobrar quien atiende. Quien supervisa cobra sin tope. Déjalo vacío
          para que nadie tenga tope.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Monto máximo
            <Input
              aria-label="Tope por cobro en pesos"
              inputMode="numeric"
              className="dato w-44"
              placeholder="Sin tope"
              value={topeEscrito}
              onChange={(e) => setTopeEscrito(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <Button variant="secundario" disabled={guardandoTope} onClick={() => void guardarTope()}>
            {guardandoTope ? 'Guardando…' : 'Guardar tope'}
          </Button>
          <span className="text-sm text-muted">
            {tope === null ? 'Hoy nadie tiene tope.' : `Hoy el tope es ${fmtClp(tope)}.`}
          </span>
        </div>

        {/* La etapa de pagado (#536). Se ELIGE de las que existen, no se
            escribe: `confirm.ts` la busca por nombre y un typo sería un embudo
            que nunca se actualiza sin que nada avise. */}
        <div className="mt-5 border-t border-line pt-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Cuando pagan, mover la oportunidad a
            <Select value={etapaPagado} onValueChange={setEtapaPagado}>
              <SelectTrigger aria-label="Etapa al pagar" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIN_MOVER}>No mover (lo hago yo)</SelectItem>
                {etapasDisponibles.map((e) => (
                  <SelectItem key={e} value={e}>{e}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <p className="mt-2 text-sm text-muted">
            {etapasDisponibles.length === 0
              ? 'Todavía no tienes etapas: arma tu embudo primero.'
              : 'El cambio queda a nombre del sistema y se puede deshacer moviéndola de vuelta.'}
          </p>
        </div>
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Conectar proveedor</span>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger aria-label="Pasarela"><SelectValue /></SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input aria-label="Nombre" placeholder="Ej: Flow sandbox" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <Input aria-label="Variable de credenciales" className="dato" placeholder="FLOW_SANDBOX_CREDENTIALS" value={credRef} onChange={(e) => setCredRef(e.target.value)} />
          <Input aria-label="Variable del secreto de webhook" className="dato" placeholder="FLOW_WEBHOOK_SECRET" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} />
        </div>
        <Button className="mt-3" disabled={!nombre.trim() || !credRef.trim()} onClick={() => void conectar()}>
          Conectar en modo test
        </Button>
      </div>

      <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
        <span className="rotulo">Proveedores</span>
        {proveedores === null ? (
          <Skeleton className="mt-3 h-16" />
        ) : proveedores.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Sin pasarela todavía: el botón Cobrar del chat avisará.</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {proveedores.map((p) => (
              <li key={p.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink">{p.name}</p>
                  <p className="dato text-muted">{p.kind} · {p.credentialRef}</p>
                </div>
                <Badge role={p.mode === 'test' ? 'warn' : 'good'}>{p.mode === 'test' ? 'Modo test' : 'Producción'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {links.length > 0 && (
        <div className="mt-4 pulso-panel rounded-tarjeta border border-line bg-raised p-6">
          <span className="rotulo">Links recientes</span>
          <ul className="mt-2 flex flex-col">
            {links.slice(0, 12).map((l) => (
              <li key={l.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-body">{l.concept}</p>
                  <p className="dato text-faint">
                    {new Date(l.createdAt).toLocaleDateString('es-CL')}
                    {l.paidAt && ` · pagado ${new Date(l.paidAt).toLocaleDateString('es-CL')}`}
                  </p>
                </div>
                <span className="dato font-bold text-ink">{fmtClp(l.amountClp)}</span>
                <Badge role={ESTADO_LINK[l.status].role}>{ESTADO_LINK[l.status].label}</Badge>
                {/* Cancelar un link emitido (#460). `POST /payments/links/:id/cancel`
                    existe desde #60 y no la llamaba nadie: un link con el
                    monto equivocado se quedaba vivo hasta que alguien lo
                    pagaba. Solo se ofrece en los que todavía no se pagan;
                    el servidor igual rechaza lo demás. */}
                {(l.status === 'created' || l.status === 'sent') && (
                  <Button
                    variant="fantasma"
                    size="chico"
                    disabled={cancelando === l.id}
                    onClick={() => void cancelar(l)}
                  >
                    {cancelando === l.id ? 'Cancelando…' : 'Cancelar'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
    </div>
  );
}
