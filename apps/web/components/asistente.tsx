'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Crear el asistente eligiendo su objetivo (#385, SPEC §14–16).
//
// `POST /agents` existía desde el principio y no lo llamaba nadie: el
// producto podía listar asistentes y cambiarles el modo, pero no crear
// ninguno. En staging había CERO, y no por falta de configuración sino
// porque no había puerta.
//
// La primera decisión es el objetivo y no el nombre, porque es la que
// cambia todo lo demás: qué herramientas recibe, qué datos pide, y con qué
// se mide si sirve. El catálogo viene del servidor
// (`GET /agents/objetivos`); acá no se inventa ninguno.

interface ObjetivoDto {
  id: string;
  titulo: string;
  destinatario: 'cliente' | 'dueño';
  requiere: string[];
  faltan: string[];
  disponible: boolean;
  datosMinimos: string[];
  detallePorDefecto: string;
  mide: boolean;
}

interface AgenteDto {
  id: string;
  name: string;
  objetivo: string | null;
  objetivoDetalle: string | null;
  defaultMode: string;
}

const NOMBRE_MODULO: Record<string, string> = {
  calendar: 'Agenda',
  crm: 'CRM',
  knowledge: 'Conocimiento',
  payments: 'Pagos',
};

export function Asistente() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [agentes, setAgentes] = useState<AgenteDto[] | null>(null);
  const [objetivos, setObjetivos] = useState<ObjetivoDto[]>([]);
  const [elegido, setElegido] = useState<ObjetivoDto | null>(null);
  const [nombre, setNombre] = useState('');
  const [detalle, setDetalle] = useState('');
  const [creando, setCreando] = useState(false);
  // Con un asistente creado el formulario desaparecía, y con él la única
  // puerta para crear otro (#415). Desde que hay asistentes del dueño eso
  // dejó de ser "un asistente por negocio": son varios, con oficios
  // distintos.
  const [abriendoOtro, setAbriendoOtro] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const [lista, cat] = await Promise.all([
        apiFetch<AgenteDto[]>(config, session, tenant, '/agents'),
        apiFetch<ObjetivoDto[]>(config, session, tenant, '/agents/objetivos').catch(() => []),
      ]);
      setAgentes(lista);
      setObjetivos(cat);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setAgentes([]);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Los objetivos van separados por con QUIÉN habla el asistente (#410).
   *
   * "Vender" y "Responder sobre los números" en la misma lista harían
   * elegir mal: no son alternativas, son asistentes distintos. Uno contesta
   * WhatsApp a tus clientes; el otro te contesta a ti, acá adentro.
   */
  const porDestinatario = [
    {
      clave: 'cliente' as const,
      titulo: 'Para contestarle a tus clientes',
      ayuda: 'Responde por WhatsApp, con lo que tú le diste.',
      items: objetivos.filter((o) => o.destinatario === 'cliente'),
    },
    {
      clave: 'dueño' as const,
      titulo: 'Para ayudarte a ti',
      ayuda: 'Te responde acá dentro del producto. No habla con nadie de afuera.',
      items: objetivos.filter((o) => o.destinatario === 'dueño'),
    },
  ].filter((g) => g.items.length > 0);

  function elegir(o: ObjetivoDto) {
    if (!o.disponible) return;
    setElegido(o);
    // La palabra del negocio arranca con el defecto puesto: nadie quiere
    // rellenar un campo vacío para escribir lo obvio.
    setDetalle(o.detallePorDefecto);
    if (!nombre.trim()) setNombre('Asistente');
  }

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || !elegido || creando) return;
    setCreando(true);
    try {
      await apiFetch(config, session, tenant, '/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: nombre.trim(),
          objetivo: elegido.id,
          objetivoDetalle: detalle.trim() || undefined,
        }),
      });
      setElegido(null);
      setNombre('');
      setDetalle('');
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreando(false);
    }
  }

  if (agentes === null) {
    return (
      <div className="mt-4 flex flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  // El título se busca POR FILA. Estaba calculado con `agentes[0]` y usado
  // en todas: con dos asistentes, los dos mostraban el objetivo del primero.
  const tituloDe = (objetivo: string | null) =>
    objetivos.find((o) => o.id === objetivo)?.titulo ?? objetivo ?? null;
  const yaCreados = new Set(agentes.map((a) => a.objetivo).filter(Boolean) as string[]);
  const mostrarFormulario = agentes.length === 0 || abriendoOtro;

  return (
    <section className="mt-4 flex flex-col gap-4">
      <header>
        <h2 className="text-base font-bold text-ink">Tu asistente</h2>
        <p className="mt-1 max-w-2xl text-sm text-body">
          Contesta en WhatsApp con lo que tú le diste: tu catálogo, tus precios, tu agenda. Nunca
          inventa un dato que no pudo confirmar, y cuando no puede resolver algo te pasa la
          conversación.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-campo border border-bad-soft-br bg-bad-soft px-4 py-3 text-sm text-bad-text">
          {error}
        </p>
      )}

      {agentes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {agentes.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 pulso-panel rounded-tarjeta border border-line bg-raised p-4"
            >
              <div className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{a.name}</span>
                  {a.objetivo ? (
                    <Badge role="info">{tituloDe(a.objetivo)}</Badge>
                  ) : (
                    <Badge role="warn">Sin objetivo</Badge>
                  )}
                </span>
                {a.objetivoDetalle && (
                  <span className="text-sm text-body">Busca dejar lista {a.objetivoDetalle}.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {agentes.length > 0 && !abriendoOtro && (
        <div>
          <Button variant="secundario" onClick={() => setAbriendoOtro(true)}>
            Crear otro asistente
          </Button>
        </div>
      )}

      {mostrarFormulario && (
        <form onSubmit={crear} className="flex flex-col gap-5 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
          <div>
            <h3 className="text-sm font-bold text-ink">¿Qué tiene que lograr?</h3>
            <p className="mt-1 text-sm text-muted">
              Es la primera decisión porque cambia todo lo demás: qué puede hacer, qué le pregunta a
              tus clientes y con qué se mide si está sirviendo.
            </p>
          </div>

          {porDestinatario.map((grupo) => (
            <div key={grupo.clave} className="flex flex-col gap-2">
              <div>
                <h4 className="text-sm font-bold text-ink">{grupo.titulo}</h4>
                <p className="text-xs text-muted">{grupo.ayuda}</p>
              </div>
            {grupo.items.map((o) => {
              const puesto = elegido?.id === o.id;
              // Dos asistentes con el mismo objetivo no se contradicen, pero
              // tampoco suman: el segundo no se usaría nunca, porque el
              // producto toma el primero activo.
              const repetido = yaCreados.has(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={puesto}
                  disabled={!o.disponible || repetido}
                  onClick={() => elegir(o)}
                  className={[
                    'flex flex-col items-start gap-1 rounded-campo border p-4 text-left transition-colors',
                    puesto ? 'border-action bg-action-soft' : 'border-line bg-bg',
                    o.disponible && !repetido
                      ? 'hover:border-line-strong'
                      : 'cursor-not-allowed opacity-60',
                  ].join(' ')}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{o.titulo}</span>
                    {!o.disponible && <Badge role="neutral">No disponible</Badge>}
                    {o.disponible && repetido && <Badge role="neutral">Ya lo tienes</Badge>}
                    {o.disponible && !o.mide && <Badge role="neutral">Sin medición propia</Badge>}
                  </span>
                  {o.disponible ? (
                    <span className="text-sm text-body">
                      {/* Los del dueño no le preguntan nada a nadie: no hay
                          datos mínimos que juntar, así que esa línea salía
                          vacía («Va a preguntar:» y nada). */}
                      {o.datosMinimos.length > 0
                        ? `Va a preguntar: ${o.datosMinimos.join(' · ')}`
                        : grupo.clave === 'dueño'
                          ? 'Trabaja con lo que ya está en tu cuenta. No le escribe a nadie.'
                          : 'No necesita juntar datos para cumplirlo.'}
                    </span>
                  ) : (
                    // No se esconde: bajar de plan nunca esconde (SPEC §6),
                    // y esto es justo lo que le dice al negocio qué le falta.
                    <span className="text-sm text-body">
                      Necesita {o.faltan.map((m) => NOMBRE_MODULO[m] ?? m).join(' y ')}, que tu plan
                      no incluye todavía.
                    </span>
                  )}
                </button>
              );
            })}
            </div>
          ))}

          {elegido && (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                {elegido.destinatario === 'dueño' ? 'De qué se trata' : 'Cómo lo llamas en tu negocio'}
                <Input
                  required
                  value={detalle}
                  onChange={(ev) => setDetalle(ev.target.value)}
                  placeholder={elegido.detallePorDefecto}
                />
                <span className="text-xs text-muted">
                  {elegido.destinatario === 'dueño'
                    ? 'En qué se concentra cuando te responda. «cómo van las ventas», «mi negocio».'
                    : 'Lo va a usar hablando con tus clientes. «una hora», «una visita a terreno», «una cotización».'}
                </span>
              </label>

              <label className="flex flex-col gap-1 text-sm font-medium text-ink">
                Nombre del asistente
                <Input required value={nombre} onChange={(ev) => setNombre(ev.target.value)} />
                <span className="text-xs text-muted">Es para ti: el cliente no lo ve.</span>
              </label>

              {elegido.destinatario === 'cliente' ? (
                <p className="text-sm text-body">
                  Arranca <strong>solo sugiriendo</strong>: escribe la respuesta y tú decides si
                  sale. Cuando le tengas confianza, le das horario para responder sola.
                </p>
              ) : (
                // El modo no aplica: este no le manda nada a nadie. Decirle
                // "arranca solo sugiriendo" sería hablarle de un riesgo que
                // no corre.
                <p className="text-sm text-body">
                  Solo habla contigo, acá dentro. No le escribe a tus clientes ni cambia nada por
                  su cuenta.
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primario" disabled={!elegido || creando}>
              {creando ? 'Creando…' : 'Crear asistente'}
            </Button>
            {agentes.length > 0 && (
              <Button
                type="button"
                variant="secundario"
                onClick={() => {
                  setAbriendoOtro(false);
                  setElegido(null);
                }}
              >
                Cancelar
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
