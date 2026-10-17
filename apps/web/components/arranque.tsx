'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';

/**
 * El arranque del shell, pedido UNA vez (#761).
 *
 * ## Por qué un proveedor y no cinco `useEffect`
 *
 * Medido: abrir la bandeja son 7 llamadas a `/v1`, y abrir una conversación
 * suma 14 más. Ninguna repetida. Y no estaban juntas: cada componente pedía lo
 * suyo por su cuenta —la campana sus avisos, el aviso de soporte su estado, el
 * menú el acceso por plan, la bandeja las respuestas rápidas— así que no había
 * ningún lugar donde agruparlas. Esto es ese lugar.
 *
 * Lo que cuesta cada llamada no es un viaje: toda ruta de `/v1` pasa por
 * `withTenant`, que hace `BEGIN`, `set_config`, la consulta y `COMMIT`. Con la
 * base lejos del VPS (#711, 64 ms por viaje) son cuatro viajes por puerta.
 *
 * ## Cada pieza dice si se puede ver
 *
 * La API contesta por pieza: `ok` con su dato, `sin-permiso`, o
 * `modulo-apagado`. Eso se conserva acá en vez de aplanarlo a `null`, porque
 * «no tienes permiso» no es «no hay»: un `null` para los dos haría que la
 * pantalla diga «no hay avisos» a quien no puede verlos.
 */

export type Pieza<T> =
  | { estado: 'ok'; dato: T }
  | { estado: 'sin-permiso' }
  | { estado: 'modulo-apagado'; modulo: string }
  /** Se cayó al cargarla. Distinto de «no hay»: esto se puede reintentar. */
  | { estado: 'falla' };

export interface NavItem {
  label: string;
  path: string;
  permission?: string;
  grupo?: string;
  seccion?: string;
}

export interface Arranque {
  /**
   * Tampoco está el estado del soporte: una pieza que tiene que estar FRESCA no
   * entra en un agregado que se pide una vez. El arranque no se vuelve a pedir,
   * así que el soporte que entra diez minutos después no aparecería nunca.
   *
   * `me` NO está acá, aunque el issue lo listara: su ruta corre sin tenant
   * porque es la que contesta *cuáles* negocios hay, y meterla en un agregado
   * por tenant hacía dos cosas mal —`tenantsOf` bajo RLS devolvía un solo
   * negocio, y con API key el arranque entero daba 500—. Se queda en `/me`.
   */
  modulos: Array<{ id: string; nav: NavItem[]; widgets: unknown[] }>;
  /**
   * Lo que esta persona puede hacer, para que el menú no ofrezca callejones
   * sin salida (#814).
   *
   * `null` = no se pudo resolver, y entonces el menú se dibuja completo. No es
   * «ningún permiso»: la diferencia es la que hace que un error transitorio de
   * la base no deje a nadie con la barra vacía.
   */
  permisos: string[] | null;
  acceso: Pieza<Array<{ id: string; acceso: 'completo' | 'solo_lectura' }>>;
  avisos: Pieza<{ items: unknown[]; unread: number }>;
  respuestasRapidas: Pieza<unknown[]>;
  etiquetas: Pieza<Array<{ id: string; name: string }>>;
  campos: Pieza<unknown[]>;
  empresas: Pieza<unknown[]>;
  /** El catálogo de secuencias del negocio: igual para toda conversación. */
  secuencias: Pieza<unknown[]>;
  retencion: Pieza<unknown>;
}

interface Estado {
  arranque: Arranque | null;
  /** Null mientras carga; el mensaje si falló. */
  error: string | null;
  /** Vuelve a pedirlo: lo usa quien acaba de cambiar algo que el arranque trae. */
  recargar: () => void;
}

const Ctx = createContext<Estado>({ arranque: null, error: null, recargar: () => {} });

/**
 * Lo último que contestó el arranque, por negocio y por sesión.
 *
 * ## Por qué hace falta un caché fuera de React
 *
 * Cada pantalla compone su propio `<AppShell>`, así que navegar entre secciones
 * DESMONTA y vuelve a montar el proveedor. Sin esto, el arranque se pedía de
 * nuevo en cada navegación: medido en CI, **cuatro veces** en tres navegaciones y
 * un «atrás».
 *
 * Y eso convertía el agrupado en lo contrario de lo que vino a hacer: antes eran
 * dos llamadas del menú repetidas por navegación; ahora habrían sido nueve
 * piezas. Lo cazó la guarda de #424 el mismo día que la endurecí para contar el
 * arranque — y vale decir que ese defecto ya existía para las dos llamadas del
 * menú: la versión anterior de esa prueba contaba ANTES de navegar, así que
 * nunca lo miró.
 *
 * La llave lleva el token además del negocio: un `access_token` nuevo es una
 * sesión nueva y puede traer otros permisos, así que servir lo de antes sería
 * mostrar lo que ya no corresponde.
 */
let enCache: { llave: string; arranque: Arranque } | null = null;

export function ProveedorDeArranque({ children }: { children: ReactNode }) {
  const { session, config } = useSession();
  /**
   * El negocio elegido se SIGUE, no se lee una vez.
   *
   * `useState` + un `useEffect` vacío lo leía al montar y nunca más, y de ahí
   * salían dos defectos:
   *
   *  · Al cambiar de negocio, el arranque no se volvía a pedir: los atajos, los
   *    candados del menú y el aviso de soporte seguían siendo del negocio
   *    anterior. Mostrar datos del negocio equivocado es peor que no mostrar
   *    nada, porque nadie lo va a dudar.
   *  · Y en el PRIMER login no hay nada en `localStorage`, así que `tenant`
   *    quedaba en null y el arranque no se pedía **nunca** en toda la sesión:
   *    bandeja sin atajos, menú sin candados, campana muda y —lo peor— el aviso
   *    de modo soporte apagado. Nada lo despertaba después de elegir negocio.
   *
   * `useSelectedTenant` escucha `iaxti-tenant-changed`, que es el evento que el
   * selector ya dispara, también en esta pestaña.
   */
  const tenant = useSelectedTenant();
  // Solo se expone la respuesta de ESTE negocio y sesión, también durante el
  // render anterior al efecto: limpiar después dejaba un fotograma ajeno (#588).
  const llaveActual = session && tenant ? `${tenant}|${session.access_token}` : null;
  const [respuesta, setRespuesta] = useState<{ llave: string; arranque: Arranque | null; error: string | null } | null>(null);
  const arranque = respuesta?.llave === llaveActual ? respuesta.arranque : null;
  const error = respuesta?.llave === llaveActual ? respuesta.error : null;
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    if (!session || !tenant) return;
    const llave = `${tenant}|${session.access_token}`;
    // Volver de otra sección no vuelve a pedirlo: es el mismo negocio y la misma
    // sesión, y el proveedor se remonta porque cada pantalla arma su AppShell.
    // Sin `&& vuelta === 0`: `recargar()` ya borra el caché, y con esa condición
    // de más el caché quedaba inservible después de la primera recarga —`vuelta`
    // se queda en 1 para siempre— así que volver de otra sección pedía de nuevo.
    if (enCache?.llave === llave) {
      setRespuesta({ llave, arranque: enCache.arranque, error: null });
      return;
    }
    // Lo que había del negocio anterior se descarta ANTES de pedir lo nuevo: si
    // se dejara, entre el cambio y la respuesta la pantalla pinta lo de allá.
    setRespuesta({ llave, arranque: null, error: null });
    const controller = new AbortController();
    void apiFetch<Arranque>(config, session, tenant, '/arranque', { signal: controller.signal })
      .then((a) => {
        if (!controller.signal.aborted) {
          enCache = { llave, arranque: a };
          setRespuesta({ llave, arranque: a, error: null });
        }
      })
      .catch((e: Error) => {
        // Si el arranque falla, cada componente tiene que poder seguir con su
        // ruta suelta: las dejamos a propósito (criterio 1 de #761 pide que el
        // arranque se AGREGUE, no que reemplace). Acá solo se guarda el motivo.
        if (!controller.signal.aborted) {
          const aviso = avisoDe(e);
          setRespuesta({ llave, arranque: null, error: [aviso.texto, aviso.rastro].filter(Boolean).join(' · ') });
        }
      });
    return () => controller.abort();
  }, [config, session, tenant, vuelta]);

  /**
   * Volver a pedirlo de verdad: invalida el caché además de disparar el efecto.
   *
   * Sin borrar `enCache`, `recargar()` volvería a servir lo mismo que ya había y
   * la pantalla no se enteraría de lo que acaba de cambiar — una recarga que no
   * recarga es peor que no tener el botón.
   */
  const recargar = useCallback(() => {
    enCache = null;
    setVuelta((v) => v + 1);
  }, []);
  const valor = useMemo(() => ({ arranque, error, recargar }), [arranque, error, recargar]);
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useArranque(): Estado {
  return useContext(Ctx);
}

/**
 * Una pieza del arranque, ya resuelta, con lo que hay que saber de ella.
 *
 * `puedeVerla` es lo que evita el error de siempre: `dato` es `undefined` tanto
 * cuando todavía no llegó como cuando no se puede ver, y un componente que solo
 * mira `dato` dibuja «no hay nada» en los dos casos.
 */
export function usePieza<K extends keyof Arranque>(
  clave: K,
): {
  cargando: boolean;
  puedeVerla: boolean;
  moduloApagado: string | null;
  dato: Arranque[K] extends Pieza<infer T> ? T | undefined : undefined;
} {
  const { arranque } = useArranque();
  const pieza = arranque ? (arranque[clave] as Pieza<unknown> | undefined) : undefined;
  return {
    cargando: arranque === null,
    puedeVerla: pieza?.estado === 'ok',
    moduloApagado: pieza?.estado === 'modulo-apagado' ? pieza.modulo : null,
    dato: (pieza?.estado === 'ok' ? pieza.dato : undefined) as never,
  };
}
