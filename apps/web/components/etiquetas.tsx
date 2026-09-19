'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, type EtiquetaDto } from '../lib/api';

// Etiquetas (#35, SPEC §29). La API estaba completa —crear, renombrar,
// borrar, asignar a un contacto— y no había pantalla.
//
// El "color" no es decoración: es un ROL de Pulso, y la regla dice que el
// color nunca es el único portador de significado. Por eso la etiqueta
// siempre lleva su nombre, y acá se elige el rol por lo que SIGNIFICA, no
// por cómo se ve.

const ROLES: Array<{ v: EtiquetaDto['role']; texto: string; para: string }> = [
  { v: 'good', texto: 'Bueno', para: 'Algo que quieres que se repita: cliente frecuente, pagó al día.' },
  { v: 'warn', texto: 'Ojo', para: 'Algo que mirar: pidió descuento, no contesta hace rato.' },
  { v: 'bad', texto: 'Problema', para: 'Algo que atender: reclamo, pago atrasado.' },
  { v: 'action', texto: 'Por hacer', para: 'Algo pendiente de tu lado.' },
  { v: 'info', texto: 'Dato', para: 'Contexto sin urgencia: vino por Instagram.' },
  { v: 'neutral', texto: 'Sin color', para: 'Solo para agrupar.' },
];

export function Etiquetas() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [items, setItems] = useState<EtiquetaDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', role: 'neutral' as EtiquetaDto['role'] });
  const [guardando, setGuardando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setItems(await apiFetch<EtiquetaDto[]>(config, session, tenant, '/tags'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      await apiFetch(config, session, tenant, '/tags', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', role: form.role });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarRol(t: EtiquetaDto, role: EtiquetaDto['role']) {
    if (!session || !tenant || ocupado) return;
    setOcupado(t.id);
    try {
      await apiFetch(config, session, tenant, `/tags/${t.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: t.name, role }),
      });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  async function borrar(t: EtiquetaDto) {
    if (!session || !tenant || ocupado) return;
    setOcupado(t.id);
    try {
      await apiFetch(config, session, tenant, `/tags/${t.id}`, { method: 'DELETE' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  if (items === null) {
    return <div className="flex flex-col gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /></div>;
  }

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-extrabold text-ink">Etiquetas</h1>
        <p className="mt-1 max-w-2xl text-sm text-body">
          Para marcar contactos y encontrarlos después. El color dice de qué tipo es, pero el
          nombre se ve siempre: nadie tiene que acordarse de qué significaba el amarillo.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-sm text-bad-text">
          {error}
        </p>
      )}

      <form onSubmit={crear} className="flex flex-col gap-4 rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">Nueva etiqueta</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm font-medium text-ink">
            Cómo se llama
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Cliente frecuente"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Qué tipo es
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as EtiquetaDto['role'] })}
              className="h-control rounded-campo border border-line-strong bg-field px-4 text-base text-ink"
            >
              {ROLES.map((r) => (
                <option key={r.v} value={r.v}>{r.texto}</option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={guardando}>
            {guardando ? 'Creando…' : 'Crear'}
          </Button>
        </div>
        <span className="text-xs text-muted">{ROLES.find((r) => r.v === form.role)?.para}</span>
        <span className="flex items-center gap-2 text-xs text-muted">
          Se va a ver así: <Badge role={form.role as BadgeRole}>{form.name || 'Tu etiqueta'}</Badge>
        </span>
      </form>

      {items.length === 0 ? (
        <div className="rounded-tarjeta border border-line bg-raised p-8 text-center">
          <h2 className="text-lg font-bold text-ink">Todavía no hay etiquetas</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-body">
            Sirven para marcar contactos por algo que a tu negocio le importa y después filtrarlos.
            Aparecen en la ficha y en la bandeja.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-tarjeta border border-line bg-raised px-4 py-3"
            >
              <Badge role={t.role as BadgeRole}>{t.name}</Badge>
              <select
                value={t.role}
                disabled={ocupado === t.id}
                onChange={(e) => void cambiarRol(t, e.target.value as EtiquetaDto['role'])}
                aria-label={`Tipo de ${t.name}`}
                className="h-9 rounded-campo border border-line bg-field px-3 text-sm text-ink"
              >
                {ROLES.map((r) => (
                  <option key={r.v} value={r.v}>{r.texto}</option>
                ))}
              </select>
              <span className="flex-1" />
              <Button variant="fantasma" size="chico" disabled={ocupado === t.id} onClick={() => void borrar(t)}>
                Borrar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
