# @iaxti/ui

Los tokens del sistema Pulso y los componentes que los usan.

## Tipografía y densidad (#297)

La escala vive en el preset; los componentes usan sus nombres y no tamaños
arbitrarios. Un `h1` con `text-titulo` por vista; subtítulos con `text-seccion`.

| Clase | Uso | Tamaño / interlineado |
|---|---|---|
| `text-titulo` | Título de la pantalla, Outfit | 24–32 px / 1.2 |
| `text-seccion` | Encabezado de sección, Outfit | 18 px / 1.4 |
| `text-cuerpo` | Prosa y formularios, Inter | 16 px / 1.6 |
| `text-dato` | Celdas y listas densas, Inter | 14 px / 1.4 |
| `text-rotulo` | Etiquetas y metadatos, Inter | 12 px / 1.4 |

El tamaño no cambia la familia: montos, RUT, fechas, teléfonos e identificadores
agregan `font-mono`; nombres, estados y explicaciones conservan Inter. La clase
histórica `dato` ya selecciona mono, mientras `text-dato` solo define el tamaño.

`data-densidad="comoda"` es el valor predeterminado para formularios y ajustes;
`data-densidad="densa"` se aplica a bandeja y listas del CRM. Las filas usan
`px-fila-x py-fila-y gap-fila-gap`; cómodo = 16/14/12 px y denso = 12/8/8 px.
Los botones y enlaces de fila conservan `min-h-control` (46 px) para poder
operarlos en celular. La densidad no reduce los controles de los formularios.

## Pulso son tokens; shadcn son componentes

No compiten: **shadcn lee variables CSS y Pulso es un archivo de variables
CSS**. Se enchufan. La pregunta "¿Pulso o shadcn?" no tiene respuesta porque
no es una disyuntiva.

| Archivo | Qué es |
|---|---|
| `pulso-tokens.css` | Los tokens, copiados **tal cual** del documento de marca. Un test lo comprueba. No se toca acá |
| `pulso-base.css` | Tipografía, foco y marca (documento §3, §9, §11) |
| `shadcn-puente.css` | La traducción: los nombres que shadcn espera (`--primary`, `--muted-foreground`) atados a los de Pulso |
| `tailwind-preset.cjs` | Las clases. Los nombres de Pulso son los que se escriben; los de shadcn están para lo que venga del registro |

## Traer un componente

```sh
cd packages/ui
npx shadcn@latest add <componente>
```

Sale en `src/react/ui/` con los tokens de Pulso ya puestos, sin hex sueltos y
sin `dark:`. Comprobado con `tooltip`.

Después hay que **exportarlo** en `src/react/index.ts`: el paquete tiene una
sola puerta y los componentes no se importan por ruta profunda.

### Qué revisar antes de darlo por bueno

1. **Hex sueltos.** El test de Pulso los caza, pero el mensaje sale en el PR
   *siguiente* cuando turbo cachea el test. Mirarlo al traerlo sale más
   barato.
2. **`dark:`.** El modo va por `data-mode` y el preset lo prohíbe. shadcn a
   veces lo genera.
3. **Emoji.** Hay test (#292), pero igual.
4. **Alturas y radios.** Pulso pide controles de 46 px y radios propios
   (botón 999, campo 14, tarjeta 22). El registro trae los suyos.

### Por qué hay un `tsc-alias` en el build

shadcn genera imports con el alias `@/`, que `tsc` **no reescribe** al
compilar: el `dist` quedaría con `require("@/react/ui/cn")` y reventaría en
ejecución aunque el typecheck pase. `tsc-alias` los pasa a relativos.

Es eso o acordarse de arreglar cada import a mano, y acordarse no es un
mecanismo.

## Los 11 de antes

`avatar`, `badge`, `button`, `dialog`, `dropdown-menu`, `input`, `select`,
`skeleton`, `switch`, `tabs` y `cn` están escritos a mano, de antes de que
esto existiera. **Funcionan y tienen decisiones nuestras adentro** (radios de
Pulso, alturas de 46 px). No se reemplazan por los del registro sin
compararlos uno por uno.

Lo mismo con `ui/icons.tsx`: diez iconos de trazo hechos a mano, estilo
lucide. Para lo nuevo se usa `lucide-react`, que es visualmente igual y es lo
que importan los bloques del registro.
