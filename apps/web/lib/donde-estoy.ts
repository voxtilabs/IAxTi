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
  /** Lo que se le ofrece a alguien parado acá. */
  ejemplos: string[];
}

/**
 * Las rutas más específicas van ARRIBA: `/ajustes/conocimiento` antes que
 * `/ajustes`, o todo lo de ajustes contestaría lo mismo.
 */
const PANTALLAS: Array<{ ruta: string; pantalla: Pantalla }> = [
  {
    ruta: '/bandeja',
    pantalla: {
      id: 'bandeja',
      ejemplos: [
        'Contéstale a los que llevan más de un día esperando',
        'Deriva a una persona cuando el cliente se enoja',
        'Arma una respuesta rápida para el precio del despacho',
      ],
    },
  },
  {
    ruta: '/oportunidades',
    pantalla: {
      id: 'oportunidades',
      ejemplos: [
        'Avísame si una cotización lleva 2 días parada',
        'Agrega una etapa de "esperando pago" antes del cierre',
        '¿En qué etapa se me caen más los negocios?',
      ],
    },
  },
  {
    ruta: '/contactos',
    pantalla: {
      id: 'contactos',
      ejemplos: [
        'Etiqueta como "mayorista" a los que compran más de 5 unidades',
        'Sácame la cartera en un Excel',
        '¿A cuántos contactos nuevos llegué este mes?',
      ],
    },
  },
  {
    ruta: '/agenda',
    pantalla: {
      id: 'agenda',
      ejemplos: [
        'Quiero atender los sábados en la mañana',
        'Recuérdale la hora al cliente el día antes',
        'Deja 15 minutos entre una hora y la siguiente',
      ],
    },
  },
  {
    ruta: '/campanas',
    pantalla: {
      id: 'campanas',
      ejemplos: [
        'Mándale la promoción a los que compraron hace más de 3 meses',
        '¿A cuánta gente le llegaría ese segmento?',
        'Arma una plantilla para avisar que llegó el pedido',
      ],
    },
  },
  {
    ruta: '/reportes',
    pantalla: {
      id: 'reportes',
      ejemplos: [
        '¿Cuánto gasté en IA este mes?',
        '¿Cuánto se demora mi equipo en contestar?',
        '¿Cuánto vendí este mes contra el pasado?',
      ],
    },
  },
  {
    ruta: '/pendientes',
    pantalla: {
      id: 'pendientes',
      ejemplos: [
        '¿Qué tengo que hacer hoy?',
        'Recuérdame llamar a los que cotizaron y no respondieron',
      ],
    },
  },
  {
    ruta: '/ajustes/conocimiento',
    pantalla: {
      id: 'conocimiento',
      ejemplos: [
        'Aquí va mi lista de precios',
        '¿Qué le falta saber al asistente para contestar bien?',
        'Mis horarios de atención son de 10 a 19',
      ],
    },
  },
  {
    ruta: '/ajustes/ia',
    pantalla: {
      id: 'asistente',
      ejemplos: [
        'Quiero un segundo asistente solo para postventa',
        'Que sea más breve y trate de usted',
        '¿Cómo le está yendo a mi asistente?',
      ],
    },
  },
  {
    ruta: '/ajustes/automatizaciones',
    pantalla: {
      id: 'automatizaciones',
      ejemplos: [
        'Avísame si una cotización lleva 2 días parada',
        'Cuando alguien pregunte por precios, mándale la lista',
        'Etiqueta solo a los que preguntan por arriendo',
      ],
    },
  },
  {
    ruta: '/ajustes/canales',
    pantalla: {
      id: 'canales',
      ejemplos: [
        'Quiero conectar mi WhatsApp',
        'Pon el chat en mi sitio web',
        '¿Por qué no me llegan los mensajes?',
      ],
    },
  },
  {
    ruta: '/ajustes/plantillas',
    pantalla: {
      id: 'plantillas',
      ejemplos: [
        'Arma una plantilla para avisar que llegó el pedido',
        'Mándale la plantilla de seguimiento a quien cotizó ayer',
      ],
    },
  },
  {
    ruta: '/ajustes/embudos',
    pantalla: {
      id: 'embudos',
      ejemplos: [
        'Arma un embudo para arriendos',
        'Agrega una etapa de "esperando pago" antes del cierre',
      ],
    },
  },
  {
    ruta: '/ajustes/equipo',
    pantalla: {
      id: 'equipo',
      ejemplos: [
        'Invita a alguien que solo atienda conversaciones',
        'Quiero que María pueda ver los reportes',
      ],
    },
  },
  {
    ruta: '/ajustes/pagos',
    pantalla: {
      id: 'cobros',
      ejemplos: [
        'Quiero cobrar por el chat',
        'Mándale un link de pago a quien cerró ayer',
      ],
    },
  },
  {
    ruta: '/ajustes/facturacion',
    pantalla: {
      id: 'facturacion',
      ejemplos: ['¿Qué incluye mi plan?', '¿Cuánto gasté en IA este mes?'],
    },
  },
  {
    ruta: '/empresas',
    pantalla: {
      id: 'empresas',
      ejemplos: [
        'Junta a estos contactos bajo la misma empresa',
        '¿Cuánto me compró esta empresa en total?',
      ],
    },
  },
  {
    ruta: '/ajustes',
    pantalla: {
      id: 'ajustes',
      ejemplos: [
        '¿Qué me falta configurar?',
        'Quiero atender los sábados en la mañana',
        'Avísame si una cotización lleva 2 días parada',
      ],
    },
  },
];

/** La pantalla de inicio: los ejemplos de siempre, que son los de partida. */
export const INICIO: Pantalla = {
  id: 'inicio',
  ejemplos: [
    '¿Qué me falta para empezar a vender?',
    'Avísame si una cotización lleva 2 días parada',
    'Quiero atender los sábados en la mañana',
    '¿Cuánto gasté en IA este mes?',
  ],
};

export function pantallaDe(ruta: string): Pantalla {
  const limpia = ruta.split('?')[0].replace(/\/+$/, '') || '/';
  const encontrada = PANTALLAS.find(
    (p) => limpia === p.ruta || limpia.startsWith(`${p.ruta}/`),
  );
  return encontrada?.pantalla ?? INICIO;
}
