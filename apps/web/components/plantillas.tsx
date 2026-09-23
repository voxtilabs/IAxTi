'use client';

import { AvisoResultado, EncabezadoDePagina } from '@iaxti/ui/react';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, EstadoVacio, Input, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch, type PlantillaDto } from '../lib/api';

// Plantillas de WhatsApp (#44, SPEC §12).
//
// La API estaba completa —crear, corregir, mandar a revisión, enviar— y no
// había pantalla: las plantillas solo se podían crear llamando a la API a
// mano. Y sin plantillas aprobadas no se le puede escribir a nadie fuera de
// la ventana de 24 h, que es la mitad de para qué sirve el producto.
//
// El estado lo manda META, no nosotros. Acá no se "aprueba" nada: se manda a
// revisión y se espera.

const ETIQUETA: Record<PlantillaDto['status'], { texto: string; rol: BadgeRole }> = {
  draft: { texto: 'Borrador', rol: 'neutral' },
  pending: { texto: 'En revisión de Meta', rol: 'warn' },
  approved: { texto: 'Aprobada', rol: 'good' },
  rejected: { texto: 'Rechazada', rol: 'bad' },
  paused: { texto: 'Pausada por Meta', rol: 'warn' },
  disabled: { texto: 'Desactivada', rol: 'neutral' },
};

const CATEGORIAS: Array<{ v: PlantillaDto['category']; texto: string; ayuda: string }> = [
  { v: 'utility', texto: 'Utilidad', ayuda: 'Confirmaciones, recordatorios, estados de un pedido.' },
  { v: 'marketing', texto: 'Marketing', ayuda: 'Promociones y novedades. Meta las revisa más estricto.' },
  { v: 'authentication', texto: 'Autenticación', ayuda: 'Códigos de verificación.' },
];

/** Cuántas variables tiene el cuerpo, contadas como las cuenta el servidor. */
function variablesDe(texto: string): number[] {
  return [...texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

export function Plantillas() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [items, setItems] = useState<PlantillaDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [enviando, setEnviando] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', body: '', category: 'utility' as PlantillaDto['category'] });
  /**
   * Cuál se está corrigiendo (#460). `PUT /plantillas/:id` existía desde
   * #44 y no la llamaba nadie: una plantilla que Meta rechazó —o una con
   * una falta de ortografía— solo se podía arreglar creando otra, y la
   * rechazada se quedaba ahí para siempre.
   */
  const [editando, setEditando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setItems(await apiFetch<PlantillaDto[]>(config, session, tenant, '/plantillas'));
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
    if (!session || !tenant || creando) return;
    setCreando(true);
    try {
      // Corregir una rechazada la devuelve a borrador y le limpia el
      // motivo del rechazo: eso lo hace el servidor, acá solo se manda.
      await apiFetch(
        config,
        session,
        tenant,
        editando ? `/plantillas/${editando}` : '/plantillas',
        {
          method: editando ? 'PUT' : 'POST',
          body: JSON.stringify({ ...form, language: 'es_CL' }),
        },
      );
      setForm({ name: '', body: '', category: 'utility' });
      setEditando(null);
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreando(false);
    }
  }

  async function aRevision(p: PlantillaDto) {
    if (!session || !tenant || enviando) return;
    setEnviando(p.id);
    try {
      await apiFetch(config, session, tenant, `/plantillas/${p.id}/revision`, { method: 'POST' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnviando(null);
    }
  }

  const vars = variablesDe(form.body);
  // El servidor exige {{1}}, {{2}}… sin saltos. Decirlo acá evita un viaje
  // y un rechazo de Meta que llega días después sin explicación.
  const varsMalNumeradas = vars.some((v, i) => v !== i + 1);

  if (items === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <EncabezadoDePagina
        rotulo="CANALES"
        titulo="Plantillas de WhatsApp"
        apoyo="Fuera de las 24 horas desde el último mensaje del cliente, WhatsApp solo deja escribir con una plantilla que Meta aprobó. Acá las creas y las mandas a revisión."
      />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      <form id="nueva-plantilla" onSubmit={crear} className="flex flex-col gap-4 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
        <h2 className="text-base font-bold text-ink">
          {editando ? 'Corregir la plantilla' : 'Nueva plantilla'}
        </h2>

        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Nombre
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            id="nombre-plantilla" placeholder="recordatorio_hora"
          />
          <span className="text-xs text-muted">
            Solo minúsculas, números y guion bajo. Es el nombre interno, el cliente no lo ve.
          </span>
        </label>

        <fieldset className="flex flex-col gap-1 text-sm font-medium text-ink">
          <legend className="mb-1">Categoría</legend>
          <div className="flex flex-wrap gap-2">
            {CATEGORIAS.map((c) => (
              <Button
                key={c.v}
                type="button"
                variant={form.category === c.v ? 'secundario' : 'fantasma'}
                size="chico"
                aria-pressed={form.category === c.v}
                onClick={() => setForm({ ...form, category: c.v })}
              >
                {c.texto}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted">
            {CATEGORIAS.find((c) => c.v === form.category)?.ayuda}
          </span>
        </fieldset>

        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Mensaje
          <textarea
            required
            rows={4}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Hola {{1}}, te recordamos tu hora del {{2}}. ¿Nos confirmas?"
            className="rounded-campo border border-line-strong bg-field px-4 py-3 text-base text-ink placeholder:text-faint"
          />
          <span className="text-xs text-muted">
            Lo que cambia por cliente va como {'{{1}}'}, {'{{2}}'}… numerado desde 1 y sin saltos.
            {vars.length > 0 && ` Detectamos ${vars.length}.`}
          </span>
        </label>

        {varsMalNumeradas && (
          <div role="alert" className="rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-dato text-warn-text">
            Las variables van desde {'{{1}}'} y sin saltos. Meta rechaza {'{{1}} {{3}}'} sin decir por qué.
          </div>
        )}

        <span className="flex flex-wrap gap-2">
          <Button type="submit" disabled={creando || varsMalNumeradas}>
            {creando
              ? 'Guardando…'
              : editando
                ? 'Guardar los cambios'
                : 'Crear borrador'}
          </Button>
          {editando && (
            <Button
              type="button"
              variant="secundario"
              onClick={() => {
                setEditando(null);
                setForm({ name: '', body: '', category: 'utility' });
              }}
            >
              Dejarla como estaba
            </Button>
          )}
        </span>
      </form>

      {items.length === 0 ? (
        <EstadoVacio titulo="Prepara tu primera plantilla"
          descripcion="Aquí verás tus plantillas y su revisión por Meta. Necesitas una aprobada para escribir fuera de la ventana de 24 horas."
          accion={{ etiqueta: 'Escribir una plantilla', onClick: () => document.getElementById('nombre-plantilla')?.focus() }} />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((p) => (
            <li key={p.id} className="pulso-panel rounded-tarjeta border border-line bg-raised p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="dato text-sm text-ink">{p.name}</span>
                <span className="text-xs text-muted">{p.language}</span>
                <Badge role={ETIQUETA[p.status].rol}>{ETIQUETA[p.status].texto}</Badge>
                {p.variables > 0 && (
                  <span className="text-xs text-muted">
                    {p.variables} {p.variables === 1 ? 'variable' : 'variables'}
                  </span>
                )}
                {/* Solo borrador y rechazada se editan: una en revisión o
                    aprobada la tiene Meta, y el servidor lo rechaza con su
                    motivo. Ofrecerlo igual sería prometer algo que no es. */}
                {(p.status === 'draft' || p.status === 'rejected') && (
                  <>
                    <Button
                      variant="secundario"
                      size="chico"
                      disabled={enviando === p.id}
                      onClick={() => void aRevision(p)}
                    >
                      {enviando === p.id ? 'Mandando…' : 'Mandar a revisión'}
                    </Button>
                    <Button
                      variant="fantasma"
                      size="chico"
                      onClick={() => {
                        setEditando(p.id);
                        setForm({ name: p.name, body: p.body, category: p.category });
                        document.getElementById('nombre-plantilla')?.focus();
                      }}
                    >
                      Corregir
                    </Button>
                  </>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-body">{p.body}</p>
              {p.rejectionReason && (
                <p className="mt-2 rounded-campo border border-bad-soft-br bg-bad-soft px-3 py-2 text-sm text-bad-text">
                  <span className="font-medium">Meta la rechazó:</span> {p.rejectionReason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
