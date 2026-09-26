'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import {
  AvisoResultado,
  Badge,
  Button,
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Loader,
  Message,
  MessageContent,
  Textarea,
  useSession,
} from '@iaxti/ui/react';
import { apiFetch } from '../lib/api';
import { selectedTenant } from './tenant-switcher';
import { pantallaDe } from '../lib/donde-estoy';

/**
 * El Agente General, presente en toda la app (#493, ADR-0025).
 *
 * Un popup que se abre desde cualquier pantalla con Ctrl+I: le pides lo que
 * necesitas en tus palabras y él busca entre las 195 herramientas del
 * producto, hace lo que se puede deshacer, y lo que NO se puede deshacer te
 * lo muestra con sus datos y espera tu visto bueno.
 *
 * Los componentes de la conversación no están escritos acá: son los AI
 * Elements del AI SDK de Vercel tematizados Pulso (`Conversation`,
 * `Message`, `Loader` en `packages/ui`), y el popup es el `Dialog` de
 * shadcn que ya usa la paleta de comandos. Lo propio es el hilo y la
 * propuesta, que es la parte que este producto tiene y ningún componente
 * genérico trae.
 */

interface PasoDto {
  herramienta: string;
  modulo: string | null;
  metodo: string;
  ruta: string;
  ok: boolean;
}

interface PropuestaDto {
  herramienta: string;
  descripcion: string;
  metodo: string;
  ruta: string;
  permiso: string | null;
  argumentos: Record<string, unknown>;
}

interface RespuestaDto {
  texto: string;
  pasos: PasoDto[];
  propuesta: PropuestaDto | null;
  truncada: boolean;
}

interface Turno {
  role: 'user' | 'assistant';
  content: string;
  pasos?: PasoDto[];
  propuesta?: PropuestaDto | null;
  /** La propuesta ya se aplicó o se descartó: el bloque queda como registro. */
  resuelta?: 'aplicada' | 'descartada';
}


/** Lo que el dueño ve de una acción: sus datos, no la ruta. */
function Propuesta({
  propuesta,
  resuelta,
  onAplicar,
  aplicando,
}: {
  propuesta: PropuestaDto;
  resuelta?: 'aplicada' | 'descartada';
  onAplicar: (aplicar: boolean) => void;
  aplicando: boolean;
}) {
  const filas = Object.entries(propuesta.argumentos ?? {});
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-tarjeta border border-warn-soft-br bg-warn-soft p-4">
      <p className="flex flex-wrap items-center gap-2">
        <strong className="font-display text-dato font-bold text-ink">
          {resuelta === 'aplicada'
            ? 'Hecho'
            : resuelta === 'descartada'
              ? 'No se hizo'
              : 'Necesito tu visto bueno'}
        </strong>
        <Badge role={resuelta === 'descartada' ? 'neutral' : resuelta ? 'good' : 'warn'}>
          {propuesta.descripcion}
        </Badge>
      </p>
      {filas.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-dato">
          {filas.map(([clave, valor]) => (
            <div key={clave} className="col-span-2 grid grid-cols-subgrid">
              <dt className="dato text-micro uppercase tracking-wide text-warn-text">{clave}</dt>
              <dd className="dato break-words text-ink">
                {typeof valor === 'object' ? JSON.stringify(valor) : String(valor)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!resuelta && (
        <span className="flex flex-wrap gap-2">
          <Button size="chico" disabled={aplicando} onClick={() => onAplicar(true)}>
            {aplicando ? 'Aplicando…' : 'Hazlo'}
          </Button>
          <Button size="chico" variant="secundario" disabled={aplicando} onClick={() => onAplicar(false)}>
            Mejor no
          </Button>
        </span>
      )}
    </div>
  );
}

export function AgenteGeneral() {
  const { config, session } = useSession();
  const [abierto, setAbierto] = useState(false);
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const campo = useRef<HTMLTextAreaElement>(null);

  // El listener del evento se suscribe una vez y llama SIEMPRE a la última
  // versión de `preguntar`: sin este ref, la suscripción se quedaría con el
  // hilo de conversación de cuando se montó y la pregunta entraría a una
  // conversación vieja.
  const preguntarRef = useRef<((p: string) => Promise<void>) | null>(null);

  // Desde dónde se abrió (#509). Es la ruta y nada más: nada de lo que haya
  // EN la pantalla entra en el contexto por estar a la vista.
  const ruta = usePathname() ?? '/';
  const pantalla = useMemo(() => pantallaDe(ruta), [ruta]);

  // Ctrl+I / ⌘I lo abre desde cualquier pantalla: es la misma tecla en toda
  // la app y por eso está acá y no en cada página.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'i' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.isComposing) {
        e.preventDefault();
        setAbierto((v) => !v);
      }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, []);

  // Las pantallas vacías abren el popup con la pregunta ya escrita (#509):
  // `EstadoVacio` vive en packages/ui y no puede saber de este componente, así
  // que el puente es un evento. La pregunta se manda sola: si solo abriéramos
  // el popup con el texto puesto, la persona tendría que apretar enviar sin
  // saber por qué, y el botón ya dijo lo que iba a pasar.
  useEffect(() => {
    const pedido = (e: Event) => {
      const pregunta = (e as CustomEvent<{ pregunta?: string }>).detail?.pregunta;
      if (!pregunta) return;
      setAbierto(true);
      void preguntarRef.current?.(pregunta);
    };
    window.addEventListener('iaxti-preguntale', pedido);
    return () => window.removeEventListener('iaxti-preguntale', pedido);
  }, []);

  // Cambiar de negocio corta la conversación: lo que se habló era de ESE
  // negocio, y seguirla con otro sería configurarlo con el contexto ajeno.
  useEffect(() => {
    const cambio = () => {
      setTurnos([]);
      setAviso(null);
      setAbierto(false);
    };
    window.addEventListener('iaxti-tenant-changed', cambio);
    window.addEventListener('storage', cambio);
    return () => {
      window.removeEventListener('iaxti-tenant-changed', cambio);
      window.removeEventListener('storage', cambio);
    };
  }, []);

  const preguntar = useCallback(
    async (pregunta: string) => {
      const tenant = selectedTenant();
      if (!session || !tenant || !pregunta.trim() || pensando) return;
      const mios: Turno[] = [...turnos, { role: 'user', content: pregunta.trim() }];
      setTurnos(mios);
      setTexto('');
      setPensando(true);
      setAviso(null);
      try {
        const r = await apiFetch<RespuestaDto>(config, session, tenant, '/agente-general', {
          method: 'POST',
          // Solo el hilo, sin los pasos ni las propuestas: eso es para la
          // pantalla, y mandárselo de vuelta al modelo sería pagar tokens
          // por algo que él mismo generó.
          body: JSON.stringify({
            turnos: mios.map(({ role, content }) => ({ role, content })),
            // El ID, no la frase: el servidor tiene la lista y la traduce.
            // Este valor termina en el system prompt, así que dejarlo libre
            // sería una puerta para escribirle instrucciones al agente. Y no
            // lo limita: tiene las mismas herramientas desde cualquier lado.
            pantalla: pantalla.id,
          }),
        });
        setTurnos([
          ...mios,
          { role: 'assistant', content: r.texto, pasos: r.pasos, propuesta: r.propuesta },
        ]);
        if (r.truncada) {
          setAviso('La respuesta quedó cortada. Pídele lo mismo en partes más chicas.');
        }
      } catch (err) {
        setAviso((err as Error).message);
      } finally {
        setPensando(false);
        campo.current?.focus();
      }
    },
    [config, session, turnos, pensando, pantalla],
  );
  preguntarRef.current = preguntar;

  /** Aplica —o descarta— la acción que quedó esperando. */
  const resolver = useCallback(
    async (indice: number, aplicar: boolean) => {
      const turno = turnos[indice];
      const propuesta = turno?.propuesta;
      const tenant = selectedTenant();
      if (!propuesta || !session || !tenant || aplicando) return;
      if (!aplicar) {
        setTurnos((antes) => antes.map((t, i) => (i === indice ? { ...t, resuelta: 'descartada' } : t)));
        return;
      }
      setAplicando(true);
      setAviso(null);
      try {
        await apiFetch(config, session, tenant, '/agente-general/aplicar', {
          method: 'POST',
          body: JSON.stringify({
            herramienta: propuesta.herramienta,
            argumentos: propuesta.argumentos,
          }),
        });
        setTurnos((antes) => antes.map((t, i) => (i === indice ? { ...t, resuelta: 'aplicada' } : t)));
      } catch (err) {
        // El motivo viene del servidor con el formato único: se muestra tal
        // cual, porque explica qué pasó y qué hacer.
        setAviso((err as Error).message);
      } finally {
        setAplicando(false);
      }
    },
    [config, session, turnos, aplicando],
  );

  return (
    <Dialog open={abierto} onOpenChange={setAbierto}>
      <Button
        variant="fantasma"
        onClick={() => setAbierto(true)}
        aria-keyshortcuts="Control+i Meta+i"
        aria-label="Pedirle algo a IAxTi"
      >
        <Sparkles aria-hidden className="size-4 text-action-text" />
        <span className="hidden sm:inline">Pídeselo a IAxTi</span>
      </Button>
      <DialogContent className="pulso-entrada flex max-h-[min(78vh,640px)] w-[calc(100vw-24px)] max-w-2xl flex-col gap-0 p-0">
        <div className="flex flex-col gap-1 border-b border-line px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-action-text" />
            Pídeselo a IAxTi
          </DialogTitle>
          <DialogDescription>
            Configura tu negocio conversando. Lo que no se puede deshacer te lo muestra antes y
            espera que lo apruebes.
          </DialogDescription>
        </div>

        <Conversation className="min-h-[220px]">
          <ConversationContent>
            {turnos.length === 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-cuerpo text-body">
                  Dime qué necesitas en tus palabras. Puedo revisar cómo va tu negocio, dejar
                  reglas que trabajen solas, armar tus embudos o cambiar cómo atiendes.
                </p>
                <ul className="flex flex-col gap-2">
                  {pantalla.ejemplos.map((e) => (
                    <li key={e}>
                      <Button variant="secundario" size="chico" onClick={() => void preguntar(e)}>
                        {e}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turnos.map((t, i) => (
              <Message key={`${i}-${t.content.slice(0, 12)}`} from={t.role}>
                {/* Los pasos: qué herramienta usó y de qué parte del producto.
                    Se muestran ARRIBA de la respuesta porque es el orden en
                    que pasaron, y porque explican de dónde salió lo que dice. */}
                {t.pasos && t.pasos.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {t.pasos.map((p, n) => (
                      <li
                        key={`${p.herramienta}-${n}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-campo border border-line bg-rest px-3 py-1.5"
                      >
                        <span className="dato text-micro text-ink">{p.herramienta}</span>
                        {p.modulo && <span className="dato text-micro text-action-text">{p.modulo}</span>}
                        {!p.ok && <Badge role="bad">no se pudo</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                <MessageContent>{t.content}</MessageContent>
                {t.propuesta && (
                  <Propuesta
                    propuesta={t.propuesta}
                    resuelta={t.resuelta}
                    aplicando={aplicando}
                    onAplicar={(aplicar) => void resolver(i, aplicar)}
                  />
                )}
              </Message>
            ))}

            {pensando && (
              <Message from="assistant">
                <MessageContent>
                  <span className="flex items-center gap-2 text-dato text-muted">
                    <Loader size={14} /> Buscando entre sus herramientas…
                  </span>
                </MessageContent>
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="flex flex-col gap-2 border-t border-line px-6 py-4">
          {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void preguntar(texto);
            }}
          >
            <Textarea
              ref={campo}
              rows={1}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void preguntar(texto);
                }
              }}
              placeholder="Pídele lo que necesitas"
              aria-label="Pídele algo a IAxTi"
              className="max-h-32"
            />
            <Button type="submit" disabled={pensando || !texto.trim()}>
              Pedir
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
