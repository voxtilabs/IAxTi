'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AvisoResultado, Badge, Button, Input, Skeleton, Textarea, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, renderQuickReply, type QuickReplyDto } from '../lib/api';

/**
 * Atajos de respuesta (#460).
 *
 * `POST /quick-replies` y `DELETE /quick-replies/:id` existen desde #39 y
 * la única pantalla que los tocaba era el desplegable de la bandeja, que
 * solo los LEE. Para tener un atajo había que crearlo llamando a la API a
 * mano; para borrar uno con una falta de ortografía, lo mismo.
 *
 * Un atajo mal escrito se manda muchas veces antes de que alguien se
 * atreva a pedir que lo arreglen.
 */
export function AtajosDeRespuesta() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [items, setItems] = useState<QuickReplyDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [form, setForm] = useState({ shortcut: '', body: '', scope: 'mio' as 'mio' | 'negocio' });
  const [creando, setCreando] = useState(false);
  const [borrando, setBorrando] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setItems(await apiFetch<QuickReplyDto[]>(config, session, tenant, '/quick-replies'));
    } catch (err) {
      setAviso((err as Error).message);
      setItems([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || creando) return;
    setCreando(true);
    try {
      await apiFetch(config, session, tenant, '/quick-replies', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ shortcut: '', body: '', scope: form.scope });
      setAviso(null);
      await cargar();
    } catch (err) {
      // Un atajo del negocio lo administra quien supervisa: el servidor lo
      // dice con su propio mensaje y acá se muestra tal cual.
      setAviso((err as Error).message);
    } finally {
      setCreando(false);
    }
  }

  async function borrar(a: QuickReplyDto) {
    if (!session || !tenant || borrando) return;
    setBorrando(a.id);
    try {
      await apiFetch(config, session, tenant, `/quick-replies/${a.id}`, { method: 'DELETE' });
      setAviso(null);
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setBorrando(null);
    }
  }

  if (!tenant) return null;
  if (items === null) return <Skeleton className="mt-8 h-24 w-full" />;

  return (
    <section className="mt-10 border-t border-line pt-8">
      <h2 className="text-base font-bold text-ink">Atajos de respuesta</h2>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Lo que se escribe todos los días, escrito una vez. En la bandeja aparecen en el botón «/»
        y se pegan en la respuesta; los del negocio los ve todo el equipo.
      </p>

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      <form onSubmit={crear} className="mt-4 flex flex-col gap-3 rounded-tarjeta border border-line bg-raised p-4">
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            Nombre del atajo
            <Input
              required
              value={form.shortcut}
              onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
              placeholder="horario"
              className="dato w-44"
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-sm font-medium text-ink">
            <legend className="mb-1">De quién es</legend>
            <span className="flex gap-2">
              {(['mio', 'negocio'] as const).map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant={form.scope === s ? 'secundario' : 'fantasma'}
                  size="chico"
                  aria-pressed={form.scope === s}
                  onClick={() => setForm({ ...form, scope: s })}
                >
                  {s === 'mio' ? 'Mío' : 'Del negocio'}
                </Button>
              ))}
            </span>
          </fieldset>
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Texto
          <Textarea
            required
            rows={2}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Hola {{nombre}}, atendemos de lunes a viernes de 9 a 18."
          />
          <span className="text-xs text-muted">
            {'{{nombre}}'} y {'{{telefono}}'} se reemplazan por los del contacto al pegarlo.
          </span>
        </label>
        <span>
          <Button type="submit" disabled={creando}>
            {creando ? 'Guardando…' : 'Guardar atajo'}
          </Button>
        </span>
      </form>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Todavía no hay atajos. El primero suele ser el horario.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-tarjeta border border-line bg-raised px-4 py-3"
            >
              <span className="dato text-sm text-ink">/{a.shortcut}</span>
              <Badge role="neutral">{a.userId ? 'Mío' : 'Del negocio'}</Badge>
              <span className="min-w-0 flex-1 truncate text-sm text-body">
                {/* Con el ejemplo puesto se ve lo que va a salir, no la
                    plantilla: una variable mal escrita se nota acá y no en
                    el teléfono de un cliente. */}
                {renderQuickReply(a.body, { nombre: 'Ana', telefono: '+56 9 1234 5678' })}
              </span>
              <Button
                variant="fantasma"
                size="chico"
                disabled={borrando === a.id}
                onClick={() => void borrar(a)}
              >
                {borrando === a.id ? 'Borrando…' : 'Borrar'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
