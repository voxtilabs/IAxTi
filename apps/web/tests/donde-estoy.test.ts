import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INICIO, pantallaDe } from '../lib/donde-estoy';

/**
 * #509: el Agente General arranca por donde está la persona.
 *
 * Lo que se prueba acá no es el mapa (eso es una lista y se lee), son las dos
 * formas en que esto se rompe sin que nadie lo note: que los ejemplos vuelvan
 * a ser los mismos en todas las pantallas, y que el front mande un id que el
 * servidor no conoce — y ahí el agente se queda sin contexto en silencio,
 * porque un id desconocido no es un error, es un null.
 */

const RAIZ = join(__dirname, '..', '..', '..');
const DEL_SERVIDOR = readFileSync(
  join(RAIZ, 'packages', 'modules', 'agents', 'application', 'agente-general.ts'),
  'utf8',
);

/** Los ids de la lista cerrada del servidor, leídos del `PANTALLAS`. */
function idsDelServidor(): Set<string> {
  const bloque = DEL_SERVIDOR.match(/export const PANTALLAS: Record<string, string> = \{([\s\S]*?)\n\};/);
  if (!bloque) throw new Error('No encontramos PANTALLAS en el módulo de agentes.');
  return new Set([...bloque[1].matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]));
}

const RUTAS = [
  '/',
  '/bandeja',
  '/oportunidades',
  '/contactos',
  '/contactos/abc-123',
  '/contactos/importar',
  '/empresas',
  '/agenda',
  '/campanas',
  '/reportes',
  '/pendientes',
  '/ajustes',
  '/ajustes/conocimiento',
  '/ajustes/ia',
  '/ajustes/automatizaciones',
  '/ajustes/canales',
  '/ajustes/plantillas',
  '/ajustes/embudos',
  '/ajustes/equipo',
  '/ajustes/pagos',
  '/ajustes/facturacion',
];

describe('desde dónde se abrió el Agente General (#509)', () => {
  it('cada pantalla ofrece lo suyo, no los mismos cuatro de siempre', () => {
    // El defecto que esto viene a cazar: el popup ofrecía «¿cuánto gasté en IA
    // este mes?» también en la pantalla de plantillas, y ahí se lee como una
    // curiosidad en vez de la forma de trabajar.
    const porRuta = new Map(RUTAS.map((r) => [r, pantallaDe(r).ejemplos.join(' | ')]));
    const distintos = new Set(porRuta.values());
    expect(distintos.size, `Hay ${RUTAS.length} rutas y solo ${distintos.size} juegos de ejemplos`)
      .toBeGreaterThanOrEqual(12);
    // Y ninguna se queda sin nada que ofrecer.
    for (const [ruta, ejemplos] of porRuta) {
      expect(ejemplos.length, `${ruta} sin ejemplos`).toBeGreaterThan(0);
    }
  });

  it('todos los ids que manda el front existen en la lista del servidor', () => {
    // Un id que el servidor no conoce no falla: queda en null y el agente
    // trabaja sin contexto. Se arreglaría solo el día que alguien lo notara
    // probando a mano, o nunca.
    const servidor = idsDelServidor();
    expect(servidor.size).toBeGreaterThan(10);
    const delFront = new Set(RUTAS.map((r) => pantallaDe(r).id));
    const huerfanos = [...delFront].filter((id) => !servidor.has(id));
    expect(huerfanos, 'El servidor no conoce estos ids: el agente se queda sin contexto').toEqual([]);
  });

  it('lo más específico gana: /ajustes/conocimiento no contesta como /ajustes', () => {
    expect(pantallaDe('/ajustes/conocimiento').id).toBe('conocimiento');
    expect(pantallaDe('/ajustes').id).toBe('ajustes');
    expect(pantallaDe('/ajustes/etiquetas').id).toBe('ajustes');
  });

  it('una ruta que no conocemos cae en el inicio, no en undefined', () => {
    expect(pantallaDe('/algo/que/no/existe')).toEqual(INICIO);
    expect(pantallaDe('/')).toEqual(INICIO);
    expect(pantallaDe('')).toEqual(INICIO);
  });

  it('la barra final y la query no cambian la pantalla', () => {
    expect(pantallaDe('/bandeja/').id).toBe('bandeja');
    expect(pantallaDe('/bandeja?conversacion=abc').id).toBe('bandeja');
  });

  it('el popup usa los ejemplos de la pantalla y ya no una lista suelta', () => {
    const fuente = readFileSync(join(__dirname, '..', 'components', 'agente-general.tsx'), 'utf8');
    expect(fuente).toContain('pantalla.ejemplos');
    expect(fuente, 'volvió la lista fija').not.toContain('const EJEMPLOS');
    // Y manda el id, no la frase: la frase la tiene el servidor.
    expect(fuente).toContain('pantalla: pantalla.id');
  });
});

describe('las pantallas vacías llevan al agente (#509)', () => {
  const componente = (ruta: string) =>
    readFileSync(join(__dirname, '..', 'components', ruta), 'utf8');

  it('los vacíos que son de configuración ofrecen pedírselo', () => {
    // Elegidos, no todos: un «nada con esa búsqueda» no se arregla
    // conversando, y «no tienes nada pendiente» es una buena noticia, no un
    // callejón. Estos cuatro son pantallas donde el negocio queda parado
    // esperando que alguien configure algo.
    for (const [archivo, pista] of [
      ['plantillas.tsx', 'plantilla'],
      ['automatizaciones.tsx', 'cotización'],
      ['crm/oportunidades.tsx', 'embudo'],
      ['canales.tsx', 'WhatsApp'],
    ] as const) {
      const fuente = componente(archivo);
      expect(fuente, `${archivo} sin la salida al agente`).toContain('pideleAIAxTi');
      expect(fuente.toLowerCase(), `${archivo}: la pregunta no habla de lo suyo`).toContain(
        pista.toLowerCase(),
      );
    }
  });

  it('el puente tiene los dos extremos', () => {
    // `EstadoVacio` vive en packages/ui y no puede importar el popup, así que
    // se hablan por un evento. Si uno de los dos lados se renombra, el botón
    // queda ahí sin hacer nada y no falla nada: por eso se prueba el nombre.
    const emisor = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'ui', 'src', 'react', 'estado-vacio.tsx'),
      'utf8',
    );
    const receptor = componente('agente-general.tsx');
    expect(emisor).toContain("'iaxti-preguntale'");
    expect(receptor).toContain("'iaxti-preguntale'");
  });

  it('el vacío de canales dejó de ser un callejón', () => {
    // Decía «la conexión guiada llega con el onboarding» y no ofrecía nada.
    const fuente = componente('canales.tsx');
    expect(fuente).not.toContain('llega con el onboarding');
    expect(fuente).toContain('Ir a la puesta en marcha');
  });
});
