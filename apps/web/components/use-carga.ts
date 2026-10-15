'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { ApiError, apiFetch, avisoDe, type Aviso } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';

/**
 * Los estados de una pantalla que carga sus propios datos (#788).
 *
 * Cinco pantallas escribieron esto en paralelo y tres cometieron los MISMOS
 * tres errores, cada una por su cuenta: un 403 dibujado como «falló» con un
 * botón Reintentar que no puede funcionar nunca, el `requestId` del error
 * tirado a la basura, y el aviso persistente reimplementado a mano existiendo
 * en el mismo paquete. Cuando varios implementadores independientes cometen el
 * mismo error, el error no es de ellos: falta el camino.
 *
 * Los nombres son los de `Pieza<T>` de `arranque.tsx`, que ya resolvió esto
 * para lo que viene en el arranque. Que una pantalla y una pieza del arranque
 * usen dos vocabularios para el mismo problema sería el problema otra vez.
 *
 * ## El quinto estado
 *
 * `Pieza` tiene cuatro y acá hay cinco. `nada-que-pedir` es que todavía no hay
 * a quién preguntarle, y pasa por dos motivos distintos con la misma
 * consecuencia: no hay negocio elegido —`selectedTenant()` se lee en un
 * efecto, así que el primer render no lo tiene— o la pantalla pide por algo
 * que aún no existe, como las corridas DEL asistente elegido cuando no hay
 * ninguno. El nombre salió de ahí: la primera versión se llamaba
 * `sin-negocio` y al migrar el segundo panel quedó claro que estaba
 * describiendo una de las causas en vez de la situación.
 *
 * No se puede meter en ninguno de los otros cuatro sin mentir:
 *
 * - Como `cargando` deja el esqueleto puesto PARA SIEMPRE cuando de verdad no
 *   hay negocio elegido. Eso no es hipotético: es el defecto que #897 tuvo que
 *   arreglar en los dos paneles de Ajustes → IA, donde «no hay asistente» se
 *   estaba leyendo como «está cargando».
 * - Como `falla` pone un «Reintentar» que no arregla nada: no falló nada,
 *   falta elegir un negocio en el selector.
 *
 * Es también lo que pide #789: que una pantalla sin negocio no se quede
 * esperando. Acá queda nombrado en el tipo, así que la pantalla tiene que
 * decidir qué hace con él y no puede olvidarlo por accidente.
 */
export type Carga<T> =
  | { estado: 'nada-que-pedir' }
  | { estado: 'cargando' }
  | { estado: 'ok'; dato: T }
  /** Sin el permiso. NO se reintenta: reintentar no da permisos. */
  | { estado: 'sin-permiso' }
  /** Se cayó. Esto sí se reintenta, y el aviso conserva `code · requestId`. */
  | { estado: 'falla'; aviso: Aviso };

/**
 * Pide una ruta de la API y devuelve en cuál de los cinco estados está.
 *
 * `ruta` en `null` es «todavía no hay qué pedir» y da `nada-que-pedir`. Eso
 * permite que una pantalla que pide por algo variable —`/agents/${id}/evals`—
 * use el mismo camino sin armar una URL con un `undefined` adentro.
 *
 * El 403 se separa por `status` y no por el texto del mensaje: el texto lo
 * escribe el servidor y cambia, el código no. Eso es lo que impide que «no
 * tienes permiso» termine con un botón que no puede funcionar.
 *
 * `reemplazar` existe para después de guardar: la pantalla ya tiene la
 * respuesta nueva en la mano y volver a pedirla es un viaje de más que además
 * parpadea.
 */
export function useCarga<T>(ruta: string | null): {
  carga: Carga<T>;
  /** Hay un pedido en vuelo SOBRE datos que ya se muestran. */
  recargando: boolean;
  reintentar: () => void;
  reemplazar: (dato: T) => void;
} {
  const { config, session } = useSession();
  /**
   * `useSelectedTenant` y no `selectedTenant()` suelto, por dos motivos.
   *
   * Leer `localStorage` durante el render desajusta la hidratación: el
   * servidor no lo tiene y dibuja el estado sin negocio, el cliente lo lee y
   * dibuja otro. Por eso la versión a mano de cada pantalla usaba un efecto.
   *
   * Y el efecto que usaban corría UNA vez al montar, así que cambiar de
   * negocio en el selector no recargaba estos paneles: quedaban mostrando los
   * datos del negocio anterior hasta que alguien recargara la página. Este
   * hook escucha `iaxti-tenant-changed`, así que la pantalla sigue al
   * selector. Las cinco pantallas que se migran acá ganan eso de regalo.
   */
  const tenant = useSelectedTenant();
  const [carga, setCarga] = useState<Carga<T>>({ estado: 'nada-que-pedir' });
  const [recargando, setRecargando] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!session || !tenant || ruta === null) {
      setCarga({ estado: 'nada-que-pedir' });
      return;
    }
    // `cancelado` y no `AbortController` a secas: lo que hay que evitar es que
    // la respuesta de un pedido viejo pise el estado de uno nuevo, y eso pasa
    // igual con una petición que ya salió y vuelve tarde.
    let cancelado = false;
    /**
     * `cargando` es solo la PRIMERA vez.
     *
     * Volver a `cargando` en cada recarga hace que el panel parpadee a
     * esqueleto después de guardar, y eso es peor que lo que había: la versión
     * a mano dejaba los datos viejos a la vista mientras pedía los nuevos. Un
     * esqueleto donde ya había contenido se lee como que algo se rompió.
     *
     * Así que si ya hay datos se quedan, y lo que avisa que hay un pedido en
     * vuelo es `recargando` — que es lo que va al `aria-busy`, no al lugar del
     * contenido.
     */
    setCarga((previo) => (previo.estado === 'ok' ? previo : { estado: 'cargando' }));
    setRecargando(true);
    const controller = new AbortController();
    void apiFetch<T>(config, session, tenant, ruta, { signal: controller.signal })
      .then((dato) => {
        if (!cancelado) setCarga({ estado: 'ok', dato });
      })
      .finally(() => {
        if (!cancelado) setRecargando(false);
      })
      .catch((err: unknown) => {
        if (cancelado || controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 403) {
          setCarga({ estado: 'sin-permiso' });
          return;
        }
        // `avisoDe` y no `err.message`: conserva `code · requestId`, que es el
        // dato con el que alguien puede buscar en los registros qué pasó. Sin
        // eso la pantalla dice «quedó registrado» sin decir con qué, y desde
        // un teléfono no hay consola donde ir a buscarlo (#659).
        setCarga({ estado: 'falla', aviso: avisoDe(err) });
      });
    return () => {
      cancelado = true;
      controller.abort();
    };
  }, [config, session, tenant, ruta, intento]);

  return {
    carga,
    recargando,
    reintentar: useCallback(() => setIntento((n) => n + 1), []),
    reemplazar: useCallback((dato: T) => setCarga({ estado: 'ok', dato }), []),
  };
}
