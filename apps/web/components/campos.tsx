'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, type CampoDto } from '../lib/api';

// Campos propios del negocio (#34, SPEC §10).
//
// La API estaba desde #34 y no había pantalla: los campos solo se podían
// declarar llamándola a mano. Y la ficha de contacto YA recibe los valores
// (`contact.custom`) — o sea que el dato llegaba al navegador y se tiraba.
//
// Es la promesa de "el CRM se adapta a tu negocio": una barbería guarda el
// tipo de corte, una inmobiliaria el barrio que busca.

const TIPOS: Array<{ v: CampoDto['type']; texto: string; ayuda: string }> = [
  { v: 'texto', texto: 'Texto', ayuda: 'Cualquier cosa escrita.' },
  { v: 'numero', texto: 'Número', ayuda: 'Cantidades, tallas, metros.' },
  { v: 'fecha', texto: 'Fecha', ayuda: 'Un día concreto.' },
  { v: 'lista', texto: 'Lista', ayuda: 'Opciones fijas que tú defines.' },
  { v: 'si_no', texto: 'Sí o no', ayuda: 'Una marca.' },
  { v: 'moneda', texto: 'Monto', ayuda: 'En pesos.' },
];

const ENTIDADES: Array<{ v: CampoDto['entity']; texto: string }> = [
  { v: 'contact', texto: 'Contactos' },
  { v: 'deal', texto: 'Oportunidades' },
  { v: 'company', texto: 'Empresas' },
];

export function Campos() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [campos, setCampos] = useState<CampoDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [quitando, setQuitando] = useState<string | null>(null);
  const [form, setForm] = useState({
    entity: 'contact' as CampoDto['entity'],
    label: '',
    type: 'texto' as CampoDto['type'],
    opciones: '',
    visibleIa: true,
  });

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setCampos(await apiFetch<CampoDto[]>(config, session, tenant, '/campos'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setCampos([]);
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
      await apiFetch(config, session, tenant, '/campos', {
        method: 'POST',
        body: JSON.stringify({
          entity: form.entity,
          label: form.label,
          type: form.type,
          visibleIa: form.visibleIa,
          ...(form.type === 'lista'
            ? { options: form.opciones.split(',').map((o) => o.trim()).filter(Boolean) }
            : {}),
        }),
      });
      setForm({ ...form, label: '', opciones: '' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  async function quitar(c: CampoDto) {
    if (!session || !tenant || quitando) return;
    setQuitando(c.id);
    try {
      await apiFetch(config, session, tenant, `/campos/${c.id}`, { method: 'DELETE' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQuitando(null);
    }
  }

  if (campos === null) {
    return <div className="flex flex-col gap-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-24 w-full" /></div>;
  }

  const porEntidad = ENTIDADES.map((e) => ({ ...e, items: campos.filter((c) => c.entity === e.v) }));

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-extrabold text-ink">Campos propios de tu negocio</h1>
        <p className="mt-1 max-w-2xl text-sm text-body">
          Lo que a tu negocio le importa guardar y el CRM no trae de fábrica: el tipo de corte, el
          barrio que busca, la talla. Aparecen en la ficha de cada contacto.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-sm text-bad-text">
          {error}
        </p>
      )}

      <form onSubmit={crear} className="flex flex-col gap-4 rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">Agregar un campo</h2>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm font-medium text-ink">
            Cómo se llama
            <Input
              required
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Tipo de corte"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Dónde va
            <select
              value={form.entity}
              onChange={(e) => setForm({ ...form, entity: e.target.value as CampoDto['entity'] })}
              className="h-control rounded-campo border border-line-strong bg-field px-4 text-base text-ink"
            >
              {ENTIDADES.map((e) => (
                <option key={e.v} value={e.v}>{e.texto}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Qué guarda
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as CampoDto['type'] })}
              className="h-control rounded-campo border border-line-strong bg-field px-4 text-base text-ink"
            >
              {TIPOS.map((t) => (
                <option key={t.v} value={t.v}>{t.texto}</option>
              ))}
            </select>
          </label>
        </div>

        <span className="text-xs text-muted">{TIPOS.find((t) => t.v === form.type)?.ayuda}</span>

        {form.type === 'lista' && (
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Las opciones, separadas por coma
            <Input
              required
              value={form.opciones}
              onChange={(e) => setForm({ ...form, opciones: e.target.value })}
              placeholder="Corte, Color, Peinado"
            />
          </label>
        )}

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.visibleIa}
            onChange={(e) => setForm({ ...form, visibleIa: e.target.checked })}
            className="mt-1"
          />
          <span>
            El asistente puede usarlo
            <span className="block text-xs text-muted">
              Si lo apagas, el dato se guarda igual pero no viaja al modelo. Útil para lo que no
              quieres que salga de tu negocio.
            </span>
          </span>
        </label>

        <span>
          <Button type="submit" disabled={guardando}>
            {guardando ? 'Agregando…' : 'Agregar campo'}
          </Button>
        </span>
      </form>

      {campos.length === 0 ? (
        <div className="rounded-tarjeta border border-line bg-raised p-8 text-center">
          <h2 className="text-lg font-bold text-ink">Todavía no hay campos propios</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-body">
            El CRM ya guarda nombre, teléfono, correo y RUT. Acá agregas lo que le falta para tu
            negocio, y aparece en la ficha de cada contacto.
          </p>
        </div>
      ) : (
        porEntidad
          .filter((e) => e.items.length > 0)
          .map((e) => (
            <div key={e.v} className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-muted">{e.texto}</h2>
              <ul className="flex flex-col gap-2">
                {e.items.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-tarjeta border border-line bg-raised px-4 py-3"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{c.label}</span>
                      <span className="dato block truncate text-xs text-muted">{c.key}</span>
                    </span>
                    <Badge role="neutral">{TIPOS.find((t) => t.v === c.type)?.texto ?? c.type}</Badge>
                    {c.options.length > 0 && (
                      <span className="text-xs text-muted">{c.options.join(' · ')}</span>
                    )}
                    {!c.visibleIa && <Badge role="warn">Oculto al asistente</Badge>}
                    <Button
                      variant="fantasma"
                      size="chico"
                      disabled={quitando === c.id}
                      onClick={() => void quitar(c)}
                    >
                      Quitar
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
      )}
    </section>
  );
}
