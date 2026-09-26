import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Los gráficos con librería (#525), y las tres cosas que no se pueden perder.
 *
 * El trazado, las escalas y los ticks los hace Recharts: era un algoritmo de
 * «ticks bonitos» mantenido por nosotros, con un caso raro a la vista —con un
 * máximo entre 0 y 4 devolvía 4, así que un negocio con 1 conversación y uno con
 * 4 veían el mismo gráfico—. Eso se borró con la función.
 *
 * Lo que NO se delegó es la accesibilidad, porque la de acá es mejor que la de la
 * librería, y el peso, porque el motivo original de escribirlo a mano fue eso.
 */

const UI = join(__dirname, '..');
const SERIES = readFileSync(join(UI, 'src', 'react', 'grafico-series.tsx'), 'utf8');
const CIERRE = readFileSync(join(UI, 'src', 'react', 'grafico-cierre.tsx'), 'utf8');
const BARRIL = readFileSync(join(UI, 'src', 'react', 'index.ts'), 'utf8');
const REPORTES = readFileSync(
  join(UI, '..', '..', 'apps', 'web', 'components', 'reportes.tsx'),
  'utf8',
);
const CSS = readFileSync(join(UI, 'pulso-vivo.css'), 'utf8');

const sinComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('el peso de la librería no lo paga todo el mundo (#525)', () => {
  it('el barril NO exporta el gráfico de series', () => {
    // Exportarlo desde `index.ts` mete recharts en la primera carga de TODAS
    // las pantallas, porque el barril es un solo módulo.
    const limpio = sinComentarios(BARRIL);
    expect(limpio).not.toMatch(/export \{[^}]*GraficoSeries/);
    // El anillo sí: no usa librería.
    expect(limpio).toMatch(/export \{ GraficoCierre \} from '\.\/grafico-cierre'/);
  });

  it('el anillo vive en su propio archivo y no importa recharts', () => {
    // Esto lo descubrí midiendo: mientras compartían archivo, importar el
    // anillo desde el barril arrastraba recharts igual y la carga diferida no
    // bajaba ni un kilobyte. Separar los exports no basta; hay que separar los
    // archivos.
    // Sin comentarios antes de buscar: la nota de ese archivo EXPLICA por qué no
    // importa recharts, así que menciona la palabra. Es la tercera vez esta
    // semana que una guarda mía se pone roja por su propia explicación; va en su
    // issue, porque hay treinta archivos de prueba con su propia copia de esto.
    expect(sinComentarios(CIERRE)).not.toContain('recharts');
    expect(CIERRE).toContain('GraficoCierre');
  });

  it('la pantalla de reportes lo carga diferido y sin SSR', () => {
    expect(REPORTES).toMatch(/dynamic\(\s*\(\) => import\('@iaxti\/ui\/react\/grafico'\)/);
    expect(REPORTES).toMatch(/ssr: false/);
    // Con un esqueleto del alto del gráfico: sin él la página salta cuando
    // llega el trozo.
    expect(REPORTES).toMatch(/loading: \(\) => <Skeleton/);
  });
});

describe('la accesibilidad se queda (#525)', () => {
  it('el gráfico sigue siendo una figura con título y descripción', () => {
    expect(SERIES).toContain('<figure');
    expect(SERIES).toContain('role="img"');
    expect(SERIES).toMatch(/aria-labelledby=\{`\$\{id\}-title \$\{id\}-desc`\}/);
  });

  it('se puede recorrer con el teclado y se lee en voz alta', () => {
    // Recharts no da esto: su interacción es de puntero. Cambiarlo por sus
    // tooltips habría sido perder en la dimensión que más importa.
    expect(SERIES).toContain('type="range"');
    expect(SERIES).toContain('aria-valuetext');
    expect(SERIES).toContain('aria-live="polite"');
  });

  it('la animación queda apagada', () => {
    // Pulso prohíbe contadores animados y movimiento continuo; recharts anima
    // por defecto.
    const animaciones = [...SERIES.matchAll(/isAnimationActive=\{(\w+)\}/g)].map((m) => m[1]);
    expect(animaciones.length).toBeGreaterThan(0);
    expect(animaciones.every((v) => v === 'false')).toBe(true);
  });
});

describe('Pulso manda sobre la paleta de la librería (#525)', () => {
  it('ni un hex suelto ni un color literal en el componente', () => {
    const limpio = sinComentarios(SERIES);
    expect(limpio).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // Los colores de serie van por token, no por nombre ni por rgb.
    expect(limpio).toMatch(/var\(--\$\{s\.tono\}-text\)/);
    expect(limpio).not.toMatch(/(?:rgb|hsl)a?\(/);
  });

  it('el tamaño y el color de los ejes salen del CSS, no del componente', () => {
    // Un `fill` o un `fontSize` en el componente es lo que Pulso prohíbe: el
    // componente no tiene por qué saber en qué modo está.
    const limpio = sinComentarios(SERIES);
    expect(limpio).not.toMatch(/fontSize:/);
    expect(limpio).not.toMatch(/tick=\{\{/);
    expect(CSS).toContain('.pulso-chart .recharts-cartesian-axis-tick text');
    expect(CSS).toContain('.pulso-chart .recharts-cartesian-grid line');
  });

  it('la escala empieza en cero', () => {
    // Una escala que arranca en el mínimo exagera cualquier variación, y acá
    // son los números de un negocio.
    expect(SERIES).toMatch(/domain=\{\[0, 'auto'\]\}/);
  });

  it('el algoritmo de ticks que manteníamos ya no existe', () => {
    // Si vuelve «por si acaso», tenemos las dos cosas que mantener.
    const limpio = sinComentarios(SERIES);
    expect(limpio).not.toContain('techoDeEscala');
    // La nota de arriba CITA el algoritmo que se borró, a propósito: quien lea
    // el archivo en un año merece saber qué había. Por eso se busca en el código.
    expect(limpio).not.toContain('Math.log10');
    expect(BARRIL).not.toContain('techoDeEscala');
  });
});
