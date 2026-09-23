import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { inventarioDelRepositorio } from './support/rutas-frontend';

/**
 * Una ruta que no usa nadie (#447, #480) — y POR QUÉ SIGUE VIVA (#492).
 *
 * Desde ADR-0025 el criterio es «toda ruta tiene **herramienta o**
 * pantalla», y el catálogo del Agente General cubre la API entera: mirado
 * así, esta guarda no tendría nada que decir nunca.
 *
 * Sigue acá porque cuida otra cosa. El catálogo le da la puerta al AGENTE;
 * esta lista dice qué cosas una PERSONA no puede hacer por sí misma, y eso
 * sigue siendo una decisión de producto que conviene ver escrita. Cada
 * entrada de abajo es, hoy, «solo por conversación» — y está bien que lo
 * sea, pero no está bien que pase sin que nadie lo note.
 *
 * El guard de `rutas-frontend` comprueba una dirección: que el frontend no
 * pida rutas que la API no declara. La otra dirección no la miraba nadie, y
 * ahí vivía un patrón entero: **función construida, sin puerta**. El
 * inventario a mano encontró dieciocho — entre ellas los derechos del
 * titular (obligación legal implementada y no ejercible), reintentar un
 * mensaje que no llegó, y las evaluaciones del asistente.
 *
 * Y la primera versión de esta guarda miraba solo la RUTA. Un `POST` a una
 * ruta que alguien lee con `GET` se daba por consumido: así pasaban
 * inadvertidas doce funciones más —editar un contacto entre ellas—, porque
 * la pantalla que las lee existe y la que las escribe no.
 *
 * Una ruta sin consumidor no rompe nada: simplemente la función no existe
 * para quien la necesita. Por eso hace falta que alguien pregunte.
 *
 * Las que legítimamente no tienen consumidor en este repositorio van abajo
 * CON SU MOTIVO, igual que las demás listas del proyecto. Tener que
 * escribir el porqué es lo que impide que la lista crezca sola.
 */
const SIN_CONSUMIDOR: Record<string, string> = {
  // Las llama la infraestructura, no una pantalla.
  'GET /health': 'Liveness: la llama Docker y Uptime Kuma (#17).',
  'GET /ready': 'Readiness: la llama el smoke del despliegue y Dokploy (#17).',
  'GET /health/modules': 'El grafo de módulos, para diagnosticar un arranque (#11).',

  // Las llama alguien de afuera.
  'POST /webhooks/channels/:accountId': 'La llama el proveedor de canales cuando entra un mensaje (#41).',
  'POST /webhooks/payments/:providerId': 'La llama el proveedor de pagos al confirmar (#61).',
  'POST /mcp': 'La llama una IA de afuera con la API key del negocio (#419).',

  // El widget del sitio arma la base y el sufijo por separado
  // (`${apiUrl}/webchat/${widgetId}` + '/sessions'), y el extractor sigue
  // una llamada, no una composición. Son suyas: `webchat-chat.tsx`.
  'GET /webchat/:widgetId/config': 'La llama el widget del sitio, que compone la base aparte (#46).',
  'POST /webchat/:widgetId/sessions': 'La llama el widget del sitio para abrir la sesión (#46).',
  'POST /webchat/:widgetId/messages': 'La llama el widget: manda el mensaje del visitante (#46).',
  'GET /webchat/:widgetId/messages': 'La llama el widget para sondear lo que le respondieron (#46).',

  // Fixtures del guard de permisos: existen para probarlo.
  'GET /demo/no-existe/:id': 'Fixture: comprueba que un módulo apagado responde 404 (#11).',
  'GET /demo/protegido': 'Fixture: comprueba que el guard exige permiso (#9).',

  'POST /agents/:id/run': 'Sin pantalla a propósito: es para el SDK y las pruebas, no para el dueño.',

  // --- Lo que SÍ es una función sin puerta, con su issue ---
  //
  // Cada una es una pantalla que falta, no una ruta de más. Se sacan de
  // esta lista a medida que se construyen; que estén acá escritas es lo
  // que impide que se olviden otra vez.
};

/** Una llamada calza con una ruta si ocupa sus ranuras, no si inventa sufijos. */
function calza(declarada: string, llamada: string): boolean {
  const cliente = llamada.split('/');
  const servidor = declarada.split('/');
  return (
    cliente.length === servidor.length &&
    servidor.every((parte, i) => (parte.startsWith(':') ? Boolean(cliente[i]) : parte === cliente[i]))
  );
}

/**
 * ¿Alguien llama a esta ruta CON ESTE VERBO? Una llamada cuyo método no se
 * pudo leer —porque las opciones vienen de una variable— cuenta para
 * cualquiera: preferimos dejar pasar una antes que mandar a nadie a buscar
 * una pantalla que sí existe.
 */
function laLlamaAlguien(declarada: string, datos: ReturnType<typeof inventarioDelRepositorio>): boolean {
  const [verbo, path] = declarada.split(' ');
  return datos.llamadas.some(
    (l) => calza(path, l.ruta) && (l.metodo === undefined || l.metodo === verbo),
  );
}

const datos = inventarioDelRepositorio(join(__dirname, '..', '..', '..'));

describe('rutas que no usa nadie (#447)', () => {
  it('toda ruta declarada tiene consumidor, o dice por qué no', () => {
    const huerfanas = datos.declaradasConVerbo.filter(
      (r) => !laLlamaAlguien(r, datos) && !(r in SIN_CONSUMIDOR),
    );
    expect(
      huerfanas,
      'Estas rutas no las llama nadie. O les falta la pantalla —que es el patrón que ' +
        'esta guarda viene a cazar— o hay que escribir en SIN_CONSUMIDOR por qué no la ' +
        'tienen:\n' + huerfanas.map((r) => `  ${r}`).join('\n'),
    ).toEqual([]);
  }, 30_000);

  it('una excepción que ya tiene pantalla se saca de la lista', () => {
    // Si no, la lista deja de ser el inventario de lo que falta: seguiría
    // diciendo "no tiene pantalla" de algo construido, y la siguiente
    // persona la leería como un mapa viejo.
    const yaConstruidas = Object.keys(SIN_CONSUMIDOR).filter((r) => laLlamaAlguien(r, datos));
    expect(yaConstruidas, 'Ya las llama alguien: sácalas de SIN_CONSUMIDOR').toEqual([]);
  }, 30_000);

  it('la lista no junta polvo: todas siguen declaradas', () => {
    // Una excepción para una ruta que ya no existe esconde el día en que
    // alguien la borre y vuelva a aparecer el mismo agujero.
    const fantasmas = Object.keys(SIN_CONSUMIDOR).filter(
      (r) => !datos.declaradasConVerbo.includes(r),
    );
    expect(fantasmas, 'Ya no están declaradas: sácalas de SIN_CONSUMIDOR').toEqual([]);
  }, 30_000);

  it('cada excepción explica POR QUÉ, no solo que falta', () => {
    for (const [ruta, motivo] of Object.entries(SIN_CONSUMIDOR)) {
      expect(motivo.length, `"${ruta}" sin explicar`).toBeGreaterThan(25);
    }
  });

  it('el verbo importa: un GET no consume el POST de la misma ruta', () => {
    // Es lo que escondía doce funciones: la pantalla que LEE existe y la
    // que ESCRIBE no, y mirando solo la ruta las dos se ven iguales.
    const falso = { ...datos, llamadas: [{ archivo: 'x', linea: 1, ruta: '/contacts', metodo: 'GET' }] };
    expect(laLlamaAlguien('GET /contacts', falso)).toBe(true);
    expect(laLlamaAlguien('POST /contacts', falso)).toBe(false);
  });

  it('el SDK cuenta como consumidor, con su verbo', () => {
    // Sus tablas generadas tienen la ruta como DATO, no como llamada. Sin
    // mirarlas, campañas y embudos parecían rutas que no usa nadie — y son
    // las que la web usa a través del cliente.
    // Solo las tablas generadas: el `fetch` interno del cliente arma su
    // método desde la tabla (`method: ruta.method`), así que ahí el verbo
    // no se puede leer del código — y no hace falta, porque la entrada de
    // la tabla ya lo trae.
    const delSdk = datos.llamadas.filter((l) => l.archivo.includes('.generated'));
    expect(delSdk.length).toBeGreaterThan(0);
    expect(delSdk.every((l) => typeof l.metodo === 'string')).toBe(true);
  });
});
