/**
 * De qué está hablando la persona cuando abre el Agente General (#509).
 *
 * El popup se abre desde cualquier pantalla y hasta ahora ofrecía los mismos
 * cuatro ejemplos en todas: si lo abres en plantillas y lo primero que te
 * ofrecen es «¿cuánto gasté en IA este mes?», se lee como una curiosidad y no
 * como la forma de trabajar. Esto es lo que hace que arranque por donde estás.
 *
 * Es la RUTA y nada más. Nada de lo que haya EN la pantalla —la conversación
 * abierta, el contacto que estás mirando— entra en el contexto por el solo
 * hecho de estar a la vista: eso es otra decisión y tiene su propia
 * conversación de privacidad.
 *
 * El agente sigue teniendo las 195 herramientas desde cualquier pantalla.
 * Esto le dice por dónde empezar, no hasta dónde llegar.
 */

export interface Pantalla {
  /**
   * El id que se le manda a la API. La FRASE la tiene el servidor, en una
   * lista cerrada: este valor termina en el system prompt del agente que
   * tiene las 195 herramientas, así que mandar texto libre desde el
   * navegador sería dejar que cualquiera con una sesión le escriba
   * instrucciones. Acá va el id y nada más.
   */
  id: string;
}

/*
 * Acá vivían los `ejemplos`, y se fueron con #584.
 *
 * Eran tres frases fijas por pantalla, y el issue las había advertido antes
 * de que existieran: «tres pastillas escritas a mano serían otra cosa
 * declarada en un lado; una sugerencia que falla al tocarla es peor que
 * ninguna». Se escribieron igual, y el aviso quedó sin aplicar.
 *
 * Medido el 12-10: `USER_PERMS` tiene `agents.use` y NO `automations.manage`,
 * así que un vendedor parado en la bandeja veía «Deriva a una persona cuando
 * el cliente se enoja», la tocaba, y el agente le contestaba que no puede —
 * sus herramientas se filtran por permiso antes de llegar al modelo.
 *
 * Ahora las sirve `GET /v1/agente-general/sugerencias`, filtradas con el
 * MISMO criterio que el agente usa para sus 195 herramientas. La lista vive
 * en `agents/domain/sugerencias.ts` y cada frase nombra la herramienta que la
 * cumpliría, así que el permiso sale del catálogo —que se genera del código— y
 * no de una anotación que alguien tenga que mantener al día.
 *
 * Lo que este archivo sigue teniendo es lo que sí le corresponde: desde qué
 * pantalla se está hablando. Eso es ruteo, y es del navegador.
 */

/**
 * Las rutas más específicas van ARRIBA: `/ajustes/conocimiento` antes que
 * `/ajustes`, o todo lo de ajustes contestaría lo mismo.
 */
const PANTALLAS: Array<{ ruta: string; pantalla: Pantalla }> = [
  {
    ruta: '/bandeja',
    pantalla: {
      id: 'bandeja',
    },
  },
  {
    ruta: '/oportunidades',
    pantalla: {
      id: 'oportunidades',
    },
  },
  {
    ruta: '/contactos',
    pantalla: {
      id: 'contactos',
    },
  },
  {
    ruta: '/agenda',
    pantalla: {
      id: 'agenda',
    },
  },
  {
    ruta: '/campanas',
    pantalla: {
      id: 'campanas',
    },
  },
  {
    ruta: '/reportes',
    pantalla: {
      id: 'reportes',
    },
  },
  {
    ruta: '/pendientes',
    pantalla: {
      id: 'pendientes',
    },
  },
  {
    ruta: '/ajustes/conocimiento',
    pantalla: {
      id: 'conocimiento',
    },
  },
  {
    ruta: '/ajustes/ia',
    pantalla: {
      id: 'asistente',
    },
  },
  {
    ruta: '/ajustes/automatizaciones',
    pantalla: {
      id: 'automatizaciones',
    },
  },
  {
    ruta: '/ajustes/canales',
    pantalla: {
      id: 'canales',
    },
  },
  {
    ruta: '/ajustes/plantillas',
    pantalla: {
      id: 'plantillas',
    },
  },
  {
    ruta: '/ajustes/embudos',
    pantalla: {
      id: 'embudos',
    },
  },
  {
    ruta: '/ajustes/equipo',
    pantalla: {
      id: 'equipo',
    },
  },
  {
    ruta: '/ajustes/pagos',
    pantalla: {
      id: 'cobros',
    },
  },
  {
    ruta: '/ajustes/facturacion',
    pantalla: {
      id: 'facturacion',
    },
  },
  {
    ruta: '/empresas',
    pantalla: {
      id: 'empresas',
    },
  },
  {
    ruta: '/ajustes',
    pantalla: {
      id: 'ajustes',
    },
  },
];

/** La pantalla de inicio: los ejemplos de siempre, que son los de partida. */
export const INICIO: Pantalla = {
  id: 'inicio',
};

export function pantallaDe(ruta: string): Pantalla {
  const limpia = ruta.split('?')[0].replace(/\/+$/, '') || '/';
  const encontrada = PANTALLAS.find(
    (p) => limpia === p.ruta || limpia.startsWith(`${p.ruta}/`),
  );
  return encontrada?.pantalla ?? INICIO;
}
