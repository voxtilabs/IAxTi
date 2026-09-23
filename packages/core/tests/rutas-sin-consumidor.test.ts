import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { inventarioDelRepositorio } from './support/rutas-frontend';

/**
 * Una ruta que no usa nadie (#447).
 *
 * El guard de `rutas-frontend` comprueba una dirección: que el frontend no
 * pida rutas que la API no declara. La otra dirección no la miraba nadie, y
 * ahí vivía un patrón entero: **función construida, sin puerta**. El
 * inventario a mano encontró dieciocho — entre ellas los derechos del
 * titular (obligación legal implementada y no ejercible), reintentar un
 * mensaje que no llegó, y las evaluaciones del asistente.
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
  '/health': 'Liveness: la llama Docker y Uptime Kuma (#17).',
  '/ready': 'Readiness: la llama el smoke del despliegue y Dokploy (#17).',
  '/health/modules': 'El grafo de módulos, para diagnosticar un arranque (#11).',

  // Las llama alguien de afuera.
  '/webhooks/channels/:accountId': 'La llama el proveedor de canales cuando entra un mensaje (#41).',
  '/webhooks/payments/:providerId': 'La llama el proveedor de pagos al confirmar (#61).',
  '/mcp': 'La llama una IA de afuera con la API key del negocio (#419).',

  // El widget del sitio arma la base y el sufijo por separado
  // (`${apiUrl}/webchat/${widgetId}` + '/sessions'), y el extractor sigue
  // una llamada, no una composición. Son suyas: `webchat-chat.tsx`.
  '/webchat/:widgetId/config': 'La llama el widget del sitio, que compone la base aparte (#46).',
  '/webchat/:widgetId/sessions': 'La llama el widget del sitio para abrir la sesión (#46).',
  '/webchat/:widgetId/messages': 'La llama el widget: manda el mensaje del visitante y sondea (#46).',

  // Fixtures del guard de permisos: existen para probarlo.
  '/demo/no-existe/:id': 'Fixture: comprueba que un módulo apagado responde 404 (#11).',
  '/demo/protegido': 'Fixture: comprueba que el guard exige permiso (#9).',

  // --- Lo que SÍ es una función sin puerta, con su issue ---
  //
  // Cada una es una pantalla que falta, no una ruta de más. Se sacan de
  // esta lista a medida que se construyen; que estén acá escritas es lo
  // que impide que se olviden otra vez.
  '/plantillas/:id': 'Falta la pantalla para editar y borrar una plantilla (#460).',
  '/agenda/disponibilidad': 'Falta la pantalla para definir los horarios de atención (#460).',
  '/agenda/huecos': 'La usa el asistente por su herramienta; la agenda no la dibuja (#460).',
  '/agents/:id/objetivo': 'Falta la pantalla: si el asistente logra su objetivo y cuánto es mérito suyo (#460).',
  '/agents/:id/run': 'Sin pantalla a propósito: es para el SDK y las pruebas, no para el dueño.',
  '/agents/executions': 'El consumo se ve agregado en Ajustes → IA; la lista cruda no tiene pantalla (#460).',
  '/campanas/segmentos/vista-previa': 'Falta: ver a quién alcanza un segmento antes de guardarlo (#460).',
  '/contacts/:id/empresa': 'Falta: enlazar un contacto con su empresa desde la ficha (#460).',
  '/payments/links/:id/cancel': 'Falta cancelar un link de pago ya emitido (#460).',
  '/platform/tenants/:id/retention': 'Falta en el panel: el override de retención por negocio (#460).',
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

const datos = inventarioDelRepositorio(join(__dirname, '..', '..', '..'));

describe('rutas que no usa nadie (#447)', () => {
  it('toda ruta declarada tiene consumidor, o dice por qué no', () => {
    const huerfanas = datos.declaradas.filter(
      (r) => !datos.llamadas.some((l) => calza(r, l.ruta)) && !(r in SIN_CONSUMIDOR),
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
    const yaConstruidas = Object.keys(SIN_CONSUMIDOR).filter((r) =>
      datos.llamadas.some((l) => calza(r, l.ruta)),
    );
    expect(yaConstruidas, 'Ya las llama alguien: sácalas de SIN_CONSUMIDOR').toEqual([]);
  }, 30_000);

  it('la lista no junta polvo: todas siguen declaradas', () => {
    // Una excepción para una ruta que ya no existe esconde el día en que
    // alguien la borre y vuelva a aparecer el mismo agujero.
    const fantasmas = Object.keys(SIN_CONSUMIDOR).filter((r) => !datos.declaradas.includes(r));
    expect(fantasmas, 'Ya no están declaradas: sácalas de SIN_CONSUMIDOR').toEqual([]);
  }, 30_000);

  it('cada excepción explica POR QUÉ, no solo que falta', () => {
    for (const [ruta, motivo] of Object.entries(SIN_CONSUMIDOR)) {
      expect(motivo.length, `"${ruta}" sin explicar`).toBeGreaterThan(25);
    }
  });

  it('el SDK cuenta como consumidor', () => {
    // Sus tablas generadas tienen la ruta como DATO, no como llamada. Sin
    // mirarlas, campañas y embudos parecían rutas que no usa nadie — y son
    // las que la web usa a través del cliente.
    expect(datos.llamadas.some((l) => l.archivo.includes('packages/sdk/'))).toBe(true);
  });
});
