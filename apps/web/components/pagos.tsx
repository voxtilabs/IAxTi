'use client';

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

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setProveedores(await apiFetch<ProveedorDto[]>(config, session, tenant, '/payments/providers'));
      setLinks(await apiFetch<LinkDto[]>(config, session, tenant, '/payments/links'));
    } catch (err) {
      setAviso((err as Error).message);
      setProveedores([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

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
      <p className="rotulo">Pagos</p>
      <h1 className="mt-1 font-display text-titulo font-bold text-ink">Cobra con links desde el chat</h1>
      <p className="mt-2 text-sm text-muted">
        Conecta tu pasarela y el equipo cobra sin salir de la conversación. Las credenciales viven
        en el servidor: aquí solo va el <span className="dato">NOMBRE</span> de la variable de
        entorno que las guarda — nunca la credencial. En este ambiente todo corre en modo test.
      </p>

      <div className="mt-6 rounded-tarjeta border border-line bg-raised p-6">
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

      <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
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
        <div className="mt-4 rounded-tarjeta border border-line bg-raised p-6">
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
              </li>
            ))}
          </ul>
        </div>
      )}

      {aviso && (
        <p role="alert" className="mt-4 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          {aviso}
        </p>
      )}
    </div>
  );
}
