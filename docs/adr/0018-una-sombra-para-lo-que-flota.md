# ADR 0018 · Una sombra, y solo para lo que flota

**Estado:** aceptada · 2026-09-20 · desvío documentado del documento de
marca Pulso v1.1 · resuelve [#294](https://github.com/voxtilabs/IAxTi/issues/294),
parte de la épica #290

## Contexto

La regla de Pulso prohíbe las sombras sin excepción, junto con gradientes,
glassmorphism, morado, emoji en la interfaz y varias cosas más. **Casi toda
esa lista es buena y se conserva**: son clichés que envejecen mal. Esta ADR
toca una sola línea.

Con tres superficies planas (`--bg`, `--bg-raised`, `--bg-rest`) y ningún
recurso de elevación, todo queda en el mismo plano. Un desplegable, un
diálogo y una tarjeta se distinguen por un filete de 1 px. Eso alcanza en
una pantalla simple y se cae en una densa, que es lo que es un CRM.

Tiene además un costo concreto y medible: casi toda plantilla de
administración libre usa sombras suaves para elevar. Con la regla tal cual,
cada bloque que se traiga (#293) hay que despintarlo a mano — y se termina
con lo mismo de hoy pero con más trabajo. Ya pasó al traer la barra lateral
(#295): hubo que quitar `shadow-lg` de la hoja y dos sombras más de
variantes.

## Decisión

Se agrega **una** sombra, tokenizada, para **una** cosa: lo que se
superpone al contenido y se puede cerrar.

```css
--elevacion-flotante: 0 8px 24px -8px rgb(18 20 28 / 0.18);   /* día */
--elevacion-flotante: 0 10px 28px -6px rgb(0 0 0 / 0.55);     /* noche */
```

Usable **solo** en: diálogo, desplegable, select, tooltip, hoja lateral y
paleta de comandos. **Nunca** en tarjetas, botones, tablas, campos ni filas.
Esas se siguen distinguiendo por superficie y filete, como hoy.

O sea: la sombra deja de ser decoración y pasa a significar *"esto está por
encima y se puede cerrar"*. Es información, no adorno — el mismo criterio
que ya se aplica al color, que nunca es el único portador de significado.

En noche la sombra es más oscura y más difusa: sobre fondo oscuro una
sombra clara no existe, y la de día resulta invisible. No es la misma
sombra "ajustada": son dos valores, uno por modo, como todo token de Pulso.

## Por qué no va en `pulso-tokens.css`

Ese archivo está copiado **tal cual** del documento de marca y un test lo
comprueba. Si el token se agregara ahí, dejaría de ser una copia y nadie se
enteraría.

Va en `pulso-base.css`, que es la capa del producto sobre la marca —donde
ya viven la densidad de filas (#297) y la tipografía base— y queda anotado
acá como desvío. Si el documento de marca lo adopta en una v1.2, el token
se muda y esta ADR se marca superada.

## Cómo se cuida

`packages/ui/tests/sombras.test.ts`:

- el token se define en un solo archivo, y en los dos modos;
- `shadow-` solo aparece en los seis componentes de la lista;
- en esos seis, la única sombra es `shadow-flotante` (nada de `shadow-lg`
  llegado del registro de shadcn);
- `shadow-none` se permite en cualquier lado: quita una sombra, no la pone.

## Alternativas descartadas

**Dejar la regla como está.** Es lo que veníamos haciendo, y el costo no es
estético: cada bloque traído hay que despintarlo, y la interfaz densa
—bandeja, tablas, diálogos encima de tablas— se lee peor.

**Permitir sombras en general.** Es exactamente cómo se llega a la interfaz
de plantilla que la épica #290 quiere evitar. Una sombra que está en todas
partes no dice nada.

**Un borde más fuerte para lo que flota.** Se probó mentalmente y no
resuelve el caso que importa: un desplegable sobre una tabla con filetes
queda como una fila más, con borde o sin él.

## Qué NO decide esta ADR

La paleta, los radios, las tipografías, el modo día/noche y el resto de la
lista de antipatrones siguen igual. Pulso está bien; esto es una línea.

## Reversión

Quitar el token, la entrada `boxShadow` del preset y las seis clases. El
test señala exactamente dónde. Lino puede vetarlo: la decisión se tomó bajo
delegación explícita ("sigue de la mejor manera") y sin su respuesta a la
pregunta 1 del #294.
