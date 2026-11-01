'use client';

import { AvisoResultado, EncabezadoDePagina, Formulario, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@iaxti/ui/react';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, EstadoVacio, Input, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, type EtiquetaDto, mensajeDeError } from '../lib/api';

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
  const tenant = useSelectedTenant();
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
      setError(mensajeDeError(e));
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
      setError(mensajeDeError(err));
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
      setError(mensajeDeError(err));
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
      setError(mensajeDeError(err));
    } finally {
      setOcupado(null);
    }
  }

  /**
   * El estado vacío ofrece una acción, y la acción es llevar al campo (#588).
   *
   * El panel que había explicaba bien para qué sirven las etiquetas y no
   * ofrecía NADA: el formulario está justo arriba, pero quien llega a una
   * pantalla vacía no tiene por qué deducir que lo que busca está más arriba
   * de lo que está leyendo. `EstadoVacio` existe para eso —«una pantalla
   * vacía que solo dice que está vacía es un callejón»— y además pone el
   * puente al Agente General, que es la vía del producto (ADR-0025).
   */
  const campoNombre = useRef<HTMLInputElement>(null);

  if (items === null) {
    return <div className="flex flex-col gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /></div>;
  }

  return (
    <section className="flex flex-col gap-6">
      <EncabezadoDePagina
        rotulo="ETIQUETAS"
        titulo="Etiquetas"
        apoyo="El nombre se ve siempre: el color no es lo único que distingue una de otra."
      />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      <Formulario onSubmit={crear} className="flex flex-col gap-4 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">Nueva etiqueta</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm font-medium text-ink">
            Cómo se llama
            <Input
              ref={campoNombre}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Cliente frecuente"
              /* Corto (#1150): el nombre de una etiqueta: dos o tres palabras. */
              className="max-w-campo-corto"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Qué tipo es
            <Select
              value={form.role}
              onValueChange={(valor) => setForm({ ...form, role: valor as EtiquetaDto['role'] })}
            >
              <SelectTrigger className="h-control bg-field text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.v} value={r.v}>{r.texto}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <Button type="submit" disabled={guardando}>
            {guardando ? 'Creando…' : 'Crear'}
          </Button>
        </div>
        <span className="text-xs text-muted">{ROLES.find((r) => r.v === form.role)?.para}</span>
        <span className="flex items-center gap-2 text-xs text-muted">
          Se va a ver así: <Badge role={form.role as BadgeRole}>{form.name || 'Tu etiqueta'}</Badge>
        </span>
      </Formulario>

      {items.length === 0 ? (
        <EstadoVacio
          titulo="Todavía no hay etiquetas"
          descripcion="Sirven para marcar contactos por algo que a tu negocio le importa y después filtrarlos. Aparecen en la ficha y en la bandeja."
          accion={{ etiqueta: 'Crear la primera', onClick: () => campoNombre.current?.focus() }}
          pideleAIAxTi="¿Qué etiquetas me conviene crear para mis contactos?"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 pulso-panel rounded-tarjeta border border-line bg-raised px-4 py-3"
            >
              <Badge role={t.role as BadgeRole}>{t.name}</Badge>
              <Select
                value={t.role}
                disabled={ocupado === t.id}
                onValueChange={(valor) => void cambiarRol(t, valor as EtiquetaDto['role'])}
              >
                <SelectTrigger className="h-9 bg-field text-sm" aria-label={`Tipo de ${t.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.v} value={r.v}>{r.texto}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="flex-1" />
              <Button
                      variant="quitar" size="chico" disabled={ocupado === t.id} onClick={() => void borrar(t)}>
                Borrar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
