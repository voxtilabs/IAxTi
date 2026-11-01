'use client';

/**
 * El estado de la conversación con IAxTi, UNO para toda la app (#1129).
 *
 * Vivía dentro del popup (`useState` en `AgenteGeneral`), así que se perdía
 * entero al cerrarlo: la «vía de configuración universal» de ADR-0025 olvidaba
 * todo cada vez que la cerrabas.
 *
 * Eso bloqueaba lo que pide ADR-0025 de verdad — que la pantalla del asistente
 * SEA la conversación—, porque con el estado adentro del popup la pantalla y
 * el popup serían dos chats distintos que no se acuerdan uno del otro. Dos
 * asistentes con dos memorias es un enredo que ya vimos en otro producto.
 *
 * Acá vive el hilo y nada más que el hilo: la UI está en `conversacion.tsx` y
 * la usan los dos lugares, sin copiarla.
 *
 * Lo que este proveedor NO hace, y queda dicho: el hilo sobrevive a cerrar el
 * popup y a navegar entre pantallas, pero NO a recargar la página. Guardarlo
 * de verdad necesita tabla, endpoint y migración, y va en su propio issue.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from '@iaxti/ui/react';
import { apiFetch, avisoDe, type Aviso } from '../../lib/api';
import { selectedTenant } from '../tenant-switcher';
import { pantallaDe } from '../../lib/donde-estoy';

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


export type { PasoDto, PropuestaDto, Turno };

export interface HiloResumen {
  id: string;
  titulo: string;
  turnos: number;
  updatedAt: string;
}

interface Agente {
  /** Mis conversaciones anteriores. `null` mientras no se han pedido. */
  hilos: HiloResumen[] | null;
  pedirHilos: () => void;
  abrirHilo: (id: string) => Promise<void>;
  olvidarHilo: (id: string) => Promise<void>;
  /** Vaciar la pantalla para empezar de nuevo, sin borrar la anterior. */
  nuevaConversacion: () => void;
  turnos: Turno[];
  texto: string;
  setTexto: (v: string) => void;
  pensando: boolean;
  aplicando: boolean;
  /**
   * El aviso CON su rastro (#788): un error sin `code · requestId` deja a la
   * persona sin nada que pegar al pedir ayuda. Era `string` y se perdía.
   */
  aviso: Aviso | null;
  sugerencias: string[] | null;
  /** Que el servidor mande las de ESTA pantalla. La llama quien se monta. */
  pedirSugerencias: () => void;
  preguntar: (pregunta: string) => Promise<void>;
  resolver: (indice: number, aplicar: boolean) => Promise<void>;
  /** Solo lo usa el popup; la pantalla está siempre abierta. */
  abierto: boolean;
  setAbierto: (v: boolean) => void;
  campo: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * El hilo vive FUERA de React, y no es capricho (#1129).
 *
 * Primero lo puse en el proveedor, con `useState`. La prueba de navegar entre
 * pantallas se puso roja y mostró por qué: en esta app **cada página monta su
 * propio `AppShell`** —no hay layout compartido—, así que ir de «Tu asistente»
 * a «Contactos» desmonta el proveedor y se lleva la conversación.
 *
 * Un contexto resuelve «dos componentes, un estado». No resuelve «el árbol se
 * vuelve a montar». Esto sí: el módulo no se recarga al navegar.
 *
 * Alcance, dicho: sobrevive a cerrar el popup y a navegar; NO a recargar la
 * página. Guardarlo de verdad necesita tabla, endpoint y migración.
 */
let hilo: Turno[] = [];
/** De qué negocio es lo que hay en `hilo`. Ver el listener de más abajo. */
let duenoDelHilo: string | null = null;
/** El id del hilo guardado, si ya se guardó alguna vez (#1131). */
let idDelHilo: string | null = null;
const oyentes = new Set<() => void>();
function fijarHilo(siguiente: Turno[] | ((antes: Turno[]) => Turno[])) {
  hilo = typeof siguiente === 'function' ? siguiente(hilo) : siguiente;
  for (const avisar of oyentes) avisar();
}
function useHilo(): Turno[] {
  return useSyncExternalStore(
    (avisar) => {
      oyentes.add(avisar);
      return () => void oyentes.delete(avisar);
    },
    () => hilo,
    // En el servidor no hay conversación todavía, y devolver `hilo` acá daría
    // un desajuste de hidratación si alguna vez quedara con algo.
    () => [],
  );
}

const Contexto = createContext<Agente | null>(null);

/**
 * Sin proveedor no hay conversación, y se dice fuerte.
 *
 * Devolver un objeto vacío dejaría un chat que no contesta y nadie sabría por
 * qué: el defecto más caro de este repo es el que no se ve.
 */
export function useAgente(): Agente {
  const valor = useContext(Contexto);
  if (!valor) throw new Error('useAgente fuera de <ProveedorAgente>');
  return valor;
}

export function ProveedorAgente({ children }: { children: ReactNode }) {
  const { config, session } = useSession();
  const [abierto, setAbierto] = useState(false);
  const turnos = useHilo();
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [hilos, setHilos] = useState<HiloResumen[] | null>(null);
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
  /**
   * Las sugerencias salen del SERVIDOR, no de una lista en el navegador (#584).
   *
   * Estaban en `donde-estoy.ts`, fijas por pantalla, y el propio issue había
   * advertido que eso sería «otra cosa declarada en un lado». Medido: un
   * vendedor en la bandeja veía «Deriva a una persona cuando el cliente se
   * enoja» —que necesita `automations.manage`, y `USER_PERMS` no lo tiene— y
   * el agente le contestaba que no puede.
   *
   * El servidor las filtra con el MISMO criterio con que el agente filtra sus
   * 195 herramientas, así que no hay sugerencia que falle al tocarla.
   *
   * Arranca en `null` y no en una lista de respaldo a propósito: un respaldo
   * sería volver a la lista fija, con su mismo defecto, justo el día que la
   * red falla. Mientras no lleguen, no se ofrece ninguna — la frase de arriba
   * ya dice qué se puede pedir.
   */
  const [sugerencias, setSugerencias] = useState<string[] | null>(null);

  /**
   * Las pide quien se monta, no un efecto atado a `abierto` (#1129).
   *
   * Antes el disparador era abrir el popup. Ahora la conversación también vive
   * incrustada en una pantalla, donde no hay «abrir»; y pedirlas en cada
   * navegación sería una llamada por página para una ayuda que capaz nadie
   * mira. Así que lo decide el que la muestra.
   */
  const pedirSugerencias = useCallback(() => {
    if (!session) return;
    // El tenant se lee en el momento, igual que en `preguntar`: puede cambiar
    // con el selector sin que esto se vuelva a montar.
    const tenant = selectedTenant();
    if (!tenant) return;
    void apiFetch<{ sugerencias: string[] }>(
      config,
      session,
      tenant,
      `/agente-general/sugerencias?pantalla=${encodeURIComponent(pantalla.id)}`,
    )
      .then((r) => setSugerencias(r.sugerencias))
      // Un fallo acá no se le muestra: es una ayuda, no el producto. Lo que NO
      // se hace es caer a una lista fija, que es el defecto que esto saca.
      .catch(() => setSugerencias([]));
  }, [session, config, pantalla.id]);

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

  /**
   * Cambiar de negocio corta la conversación: lo que se habló era de ESE
   * negocio, y seguirla con otro sería configurarlo con el contexto ajeno.
   *
   * Pero se compara el id, no se confía en que el evento signifique un cambio
   * (#1129). El listener se dispara también al navegar —el selector se vuelve
   * a montar en cada pantalla y avisa—, así que borraba el hilo en cada
   * navegación.
   *
   * No se notaba porque el popup se cerraba al navegar y nadie veía que la
   * conversación se hubiera ido. Con la conversación incrustada en una
   * pantalla, se nota al primer clic.
   */
  useEffect(() => {
    const cambio = () => {
      const ahora = selectedTenant();
      if (ahora === duenoDelHilo) return;
      duenoDelHilo = ahora;
      idDelHilo = null;
      fijarHilo([]);
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

  /**
   * Guardar lo que la pantalla DIBUJA, no lo que el modelo recibió (#1131).
   *
   * `conversar` manda solo los turnos de texto —sin pasos ni propuestas, a
   * propósito—. Lo que hay que poder recuperar incluye si una propuesta se
   * aplicó o se descartó, y eso vive acá. Por eso endpoint aparte y por eso
   * se manda el hilo entero cada vez.
   *
   * En segundo plano y sin avisar si falla: perder el guardado no puede
   * interrumpir la conversación que la persona está teniendo. Lo que sí
   * pasa es que el id vuelve, para que el siguiente guardado reemplace en
   * vez de crear una conversación nueva en cada vuelta.
   */
  const guardar = useCallback(
    (turnosAGuardar: Turno[]) => {
      const tenant = selectedTenant();
      if (!session || !tenant || turnosAGuardar.length === 0) return;
      void apiFetch<{ id: string }>(config, session, tenant, '/agente-general/hilos', {
        method: 'POST',
        body: JSON.stringify({ id: idDelHilo, turnos: turnosAGuardar }),
      })
        .then((r) => {
          idDelHilo = r.id;
          setHilos(null);
        })
        .catch(() => undefined);
    },
    [config, session],
  );

  const preguntar = useCallback(
    async (pregunta: string) => {
      const tenant = selectedTenant();
      if (!session || !tenant || !pregunta.trim() || pensando) return;
      duenoDelHilo = tenant;
      const mios: Turno[] = [...turnos, { role: 'user', content: pregunta.trim() }];
      fijarHilo(mios);
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
        const completo: Turno[] = [
          ...mios,
          { role: 'assistant', content: r.texto, pasos: r.pasos, propuesta: r.propuesta },
        ];
        fijarHilo(completo);
        // Guardar al terminar la vuelta y no al empezarla: si el proveedor
        // falla, lo que queda guardado es la conversación que de verdad pasó
        // y no una pregunta colgando sin respuesta (#1131).
        guardar(completo);
        if (r.truncada) {
          setAviso({ texto: 'La respuesta quedó cortada. Pídele lo mismo en partes más chicas.', rastro: null });
        }
      } catch (err) {
        setAviso(avisoDe(err));
      } finally {
        setPensando(false);
        campo.current?.focus();
      }
    },
    [config, session, turnos, pensando, pantalla, guardar],
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
        fijarHilo((antes) => {
          const siguiente = antes.map((t, i) => (i === indice ? { ...t, resuelta: 'descartada' as const } : t));
          guardar(siguiente);
          return siguiente;
        });
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
        // También acá: resolver cambia un turno ANTERIOR, que es justo lo
        // que se perdería si el guardado fuera «agregar el último».
        fijarHilo((antes) => {
          const siguiente = antes.map((t, i) => (i === indice ? { ...t, resuelta: 'aplicada' as const } : t));
          guardar(siguiente);
          return siguiente;
        });
      } catch (err) {
        // El motivo viene del servidor con el formato único: se muestra tal
        // cual, porque explica qué pasó y qué hacer.
        setAviso(avisoDe(err));
      } finally {
        setAplicando(false);
      }
    },
    [config, session, turnos, aplicando, guardar],
  );


  const pedirHilos = useCallback(() => {
    const tenant = selectedTenant();
    if (!session || !tenant) return;
    void apiFetch<{ items: HiloResumen[] }>(config, session, tenant, '/agente-general/hilos')
      .then((r) => setHilos(r.items))
      // Sin historial se sigue conversando: es una ayuda, no el producto.
      .catch(() => setHilos([]));
  }, [config, session]);

  const abrirHilo = useCallback(
    async (id: string) => {
      const tenant = selectedTenant();
      if (!session || !tenant) return;
      try {
        const r = await apiFetch<{ turnosCompletos: Turno[] }>(
          config, session, tenant, `/agente-general/hilos/${id}`,
        );
        idDelHilo = id;
        duenoDelHilo = tenant;
        fijarHilo(r.turnosCompletos ?? []);
        setAviso(null);
      } catch (err) {
        setAviso(avisoDe(err));
      }
    },
    [config, session],
  );

  const olvidarHilo = useCallback(
    async (id: string) => {
      const tenant = selectedTenant();
      if (!session || !tenant) return;
      try {
        await apiFetch(config, session, tenant, `/agente-general/hilos/${id}`, { method: 'DELETE' });
        // Si era la que está abierta, la pantalla queda limpia: seguir
        // escribiendo en una conversación borrada la resucitaría.
        if (idDelHilo === id) {
          idDelHilo = null;
          fijarHilo([]);
        }
        setHilos((antes) => (antes ?? []).filter((h) => h.id !== id));
      } catch (err) {
        setAviso(avisoDe(err));
      }
    },
    [config, session],
  );

  /** Empezar de nuevo sin borrar la anterior: la de antes queda en la lista. */
  const nuevaConversacion = useCallback(() => {
    idDelHilo = null;
    fijarHilo([]);
    setAviso(null);
  }, []);

  const valor = useMemo<Agente>(
    () => ({
      turnos, texto, setTexto, pensando, aplicando, aviso, sugerencias,
      pedirSugerencias, preguntar, resolver, abierto, setAbierto, campo,
      hilos, pedirHilos, abrirHilo, olvidarHilo, nuevaConversacion,
    }),
    [turnos, texto, pensando, aplicando, aviso, sugerencias, pedirSugerencias, preguntar, resolver,
     abierto, hilos, pedirHilos, abrirHilo, olvidarHilo, nuevaConversacion],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}
