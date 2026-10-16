'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, EncabezadoDePagina, Formulario, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, useSession } from '@iaxti/ui/react';
import { myBusinesses, registerBusiness, type BusinessRegistration } from '@iaxti/sdk';
import { selectTenant } from './tenant-switcher';
import { avisoDe, type Aviso } from '../lib/api';

/** Solo ofrece crear cuando /me confirmó que la sesión no tiene negocios. */
export function RegistroInicial() {
  const { session } = useSession();
  return session ? <RegistroConSesion key={session.user.id} /> : null;
}

function RegistroConSesion() {
  const { session, config } = useSession();
  const [status, setStatus] = useState<'loading' | 'empty' | 'existing' | 'error'>('loading');
  const [error, setError] = useState<Aviso | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<BusinessRegistration>({ displayName: '', name: '', description: '', vertical: 'otro' });
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const idempotency = useRef<string>('');
  const retry = useCallback(async (signal: AbortSignal) => {
    if (!session) return;
    const current = ++generation.current;
    setStatus('loading'); setError(null);
    try {
      const result = await myBusinesses({ apiUrl: config.apiUrl, token: session.access_token }, signal);
      if (signal.aborted || current !== generation.current) return;
      if (result.tenants.length) {
        setStatus('existing'); selectTenant(result.tenants[0]!.tenantId);
      } else setStatus('empty');
    } catch (err) {
      if (!signal.aborted && current === generation.current) { setError(avisoDe(err)); setStatus('error'); }
    }
  }, [config.apiUrl, session]);
  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    idempotency.current = crypto.randomUUID();
    setSaving(false);
    void retry(controller.signal);
    return () => controller.abort();
  }, [retry]);

  if (!session) return null;
  if (status === 'loading' || status === 'existing') return <p role="status" className="text-muted">Abriendo tus negocios…</p>;
  if (status === 'error') return <section className="pulso-panel rounded-tarjeta border border-line bg-raised p-6">
    <p role="alert" className="text-body">{error?.texto}</p>
    {error?.rastro && <p className="dato mt-2 break-all text-xs text-muted">{error.rastro}</p>}
    <Button variant="secundario" className="mt-4" onClick={() => pending.current && void retry(pending.current.signal)}>Volver a intentar</Button>
  </section>;

  return <section aria-label="Registro del negocio" className="pulso-panel max-w-xl rounded-tarjeta border border-line bg-raised p-6">
    <EncabezadoDePagina rotulo="PUESTA EN MARCHA" titulo="Pon tu negocio en marcha" apoyo="Cuéntanos quién eres y a qué te dedicas. Después revisarás lo que propone el configurador antes de aplicarlo." />
    <p className="mt-2 text-sm text-muted">Prueba gratis de <span className="dato">14 días</span> con los módulos de Crece, sin tarjeta.</p>
    <Formulario className="mt-6 flex flex-col gap-4" aria-busy={saving} onSubmit={(event) => {
      event.preventDefault();
      if (saving || !pending.current) return;
      const current = generation.current;
      const signal = pending.current.signal;
      setSaving(true); setError(null);
      void registerBusiness({ apiUrl: config.apiUrl, token: session.access_token }, form, idempotency.current, signal)
        .then((result) => {
          if (signal.aborted || current !== generation.current) return;
          selectTenant(result.tenantId);
          window.dispatchEvent(new Event('iaxti-memberships-changed'));
        }).catch((err: unknown) => {
          if (!signal.aborted && current === generation.current) setError(avisoDe(err));
        }).finally(() => {
          if (!signal.aborted && current === generation.current) setSaving(false);
        });
    }}>
      <label className="flex flex-col gap-1 text-sm text-body">Tu nombre
        <Input autoComplete="name" required maxLength={100} disabled={saving} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-body">Nombre del negocio
        <Input autoComplete="organization" required maxLength={100} disabled={saving} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <div className="flex flex-col gap-1 text-sm text-body"><label htmlFor="registro-rubro">Rubro</label>
        <Select value={form.vertical} disabled={saving} onValueChange={(value) => setForm({ ...form, vertical: value as BusinessRegistration['vertical'] })}>
          <SelectTrigger id="registro-rubro"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="belleza">Belleza y estética</SelectItem><SelectItem value="salud">Salud</SelectItem>
            <SelectItem value="inmobiliaria">Inmobiliaria</SelectItem><SelectItem value="retail">Tienda / retail</SelectItem>
            <SelectItem value="servicios">Servicios profesionales</SelectItem><SelectItem value="otro">Otro</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex flex-col gap-1 text-sm text-body">Descripción del negocio
        <Textarea required minLength={10} maxLength={4000} rows={4} disabled={saving} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      {error && <div role="alert" className="text-bad-text"><p>{error.texto}</p>{error.rastro && <p className="dato mt-2 break-all text-xs">{error.rastro}</p>}</div>}
      <Button type="submit" disabled={saving}>{saving ? 'Creando tu negocio…' : 'Crear mi negocio'}</Button>
    </Formulario>
  </section>;
}
