'use client';

/**
 * El dibujo de las vistas del asistente (#1380).
 *
 * Cada componente del catálogo (`packages/modules/agents/application/vistas.ts`)
 * se enchufa acá a UN componente Mesón: la IA compone, pero lo que se ve —
 * tokens, medidas, mono para cifras— lo decide esta pantalla y nadie más.
 * `createRenderer` solo resuelve el árbol; el estilo no viene de la
 * biblioteca sino de las variables de siempre (ADR-0034).
 *
 * Tres capas antes de dibujar, de afuera hacia adentro:
 *
 *  1. `vistaConfiable`: la vista se revalida contra el MISMO catálogo que
 *     validó el servidor. Entre el servidor y acá hay un localStorage —el hilo
 *     guardado— que cualquiera puede editar a mano, y el que dibuja no confía
 *     en el que guarda.
 *  2. `LimiteDeVista`: si dibujar revienta por un defecto nuestro, se cae LA
 *     vista — el hilo sigue vivo y la respuesta en prosa queda igual.
 *  3. `createRenderer`: componentes desconocidos no existen, porque el
 *     catálogo los rechazó; por eso no hay `fallback` que dibuje «algo».
 */
import { Component, useMemo, type ReactNode } from 'react';
import { createRenderer } from '@json-render/react';
// Por `./vistas` y no por la raíz del módulo: el `contract` es un barril que
// arrastra runtime, proveedores y pg — cosas de servidor que el navegador no
// puede cargar. `application/vistas` solo depende de @json-render/core y zod.
import { vistaConfiable, CATALOGO_DE_VISTAS, type Vista } from '@iaxti/module-agents/vistas';
import { Badge, cn } from '@iaxti/ui/react';

const RendererDeVistas = createRenderer(CATALOGO_DE_VISTAS, {
  Zona: ({ element, children }) => (
    <div className="flex flex-col gap-3">
      {element.props.titulo ? <p className="text-rotulo text-muted">{element.props.titulo}</p> : null}
      {children}
    </div>
  ),
  Tabla: ({ element }) => (
    <div className="overflow-hidden rounded-tarjeta border border-line bg-raised">
      {element.props.titulo ? (
        <p className="border-b border-line px-3 py-2 text-rotulo text-muted">{element.props.titulo}</p>
      ) : null}
      {/* `overflow-x-auto` y no columnas apretadas: una tabla de seis columnas
          a 360 px se desliza; el texto de una celda no. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-dato">
          <thead>
            <tr className="border-b border-line bg-rest">
              {element.props.columnas.map((columna) => (
                <th key={columna} scope="col" className="px-3 py-2 font-normal text-rotulo text-muted">
                  {columna}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {element.props.filas.map((fila, i) => (
              // El índice y no la celda: una fila se repite y su contenido no
              // es clave — dos contactos pueden llamarse igual.
              <tr key={i} className="border-b border-line last:border-b-0">
                {fila.map((celda, j) => (
                  <td
                    key={j}
                    className={cn(
                      'px-3 py-2 text-ink',
                      // Teléfono, monto, fecha u hora: la firma de Mesón, en
                      // mono (ADR-0034). Lo pidió el modelo, columna por
                      // columna, y el catálogo lo acotó a booleanos.
                      element.props.mono?.[j] && 'font-mono tabular-nums',
                    )}
                  >
                    {celda}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ),
  Metrica: ({ element }) => (
    <div className="rounded-tarjeta border border-line bg-raised px-4 py-3">
      <p className="text-rotulo text-muted">{element.props.rotulo}</p>
      {/* Una métrica ES una cifra: mono siempre, sin pedirle al modelo que lo
          acuerde (ADR-0034). */}
      {/* Y un escalón más grande que su rótulo y su detalle: la jerarquía la
          pone el tamaño, no el color (ADR-0034). */}
      <p className="mt-0.5 font-mono text-seccion text-ink tabular-nums">{String(element.props.valor)}</p>
      {element.props.detalle ? <p className="mt-1 text-dato text-body">{element.props.detalle}</p> : null}
    </div>
  ),
  Tarjeta: ({ element }) => (
    <div className="rounded-tarjeta border border-line bg-raised px-4 py-3">
      <p className="text-rotulo text-muted">{element.props.titulo}</p>
      <p className="text-dato text-body">{element.props.texto}</p>
    </div>
  ),
  Etiqueta: ({ element }) => <Badge role={element.props.tono}>{element.props.texto}</Badge>,
});

/**
 * Que un defecto en el dibujo no se lleve el hilo puesto.
 *
 * Los props ya pasaron el catálogo, así que esto no es desconfianza del
 * modelo: es el seguro contra NUESTROS defectos — un componente que reviente
 * con un caso que el catálogo dejó pasar tumba el chat entero si nadie
 * atrapa, y la conversación es lo último que puede caerse.
 */
class LimiteDeVista extends Component<{ children: ReactNode }, { cayo: boolean }> {
  state = { cayo: false };
  static getDerivedStateFromError() {
    return { cayo: true };
  }
  render() {
    return this.state.cayo ? null : this.props.children;
  }
}

/** La vista de un turno, tal como se dibuja bajo la respuesta en prosa. */
export function VistaDelAgente({ vista }: { vista: Vista | null | undefined }) {
  // El hilo guardado vuelve del localStorage: se revalida en cada dibujo y
  // no una vez al cargar, porque el turno puede cambiar de contenido sin que
  // el componente se desmonte.
  const confiable = useMemo(() => (vista ? vistaConfiable(vista) : null), [vista]);
  if (!confiable) return null;
  return (
    <div className="mt-2 w-full max-w-full">
      <LimiteDeVista>
        <RendererDeVistas spec={confiable} />
      </LimiteDeVista>
    </div>
  );
}
