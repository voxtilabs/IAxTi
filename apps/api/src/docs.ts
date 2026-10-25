import { readFileSync } from 'node:fs';

/**
 * La página de /docs con Scalar (#594), sobre el MISMO contrato.
 *
 * Lo que Lino pidió es el visor, no otro documento: /docs-json sigue siendo
 * el OpenAPI intacto que consumen el SDK y el catálogo del Agente General
 * (ADR-0025) — si Scalar necesitara tocarlo, no iría.
 *
 * El tema son los TOKENS de Pulso, no el de fábrica: el CSS se lee de
 * @iaxti/ui en runtime (la única fuente de los valores; copiarlos acá sería
 * la segunda copia que envejece) y un mapeo corto lo traduce a las variables
 * de Scalar. Día y noche por data-mode según prefers-color-scheme, como el
 * front antes de tener sesión.
 *
 * El visor carga de CDN y eso queda DICHO: sin internet, /docs muestra el
 * aviso y /docs-json —el contrato, que es lo que importa— funciona igual.
 * Empaquetar el bundle habría metido una dependencia de front al api por
 * una página; el costo de decirlo es menor.
 */
export function tokensDePulso(): string {
  try {
    return readFileSync(require.resolve('@iaxti/ui/pulso-tokens.css'), 'utf8');
  } catch {
    // Sin el paquete a mano (una imagen recortada de más): la página sirve
    // igual con el tema de sistema, y el motivo queda a la vista en el HTML.
    return '/* pulso-tokens.css no disponible en esta imagen: tema del sistema */';
  }
}

export function paginaDeDocs(): string {
  return `<!doctype html>
<html lang="es-CL">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IAxTi API</title>
<style>
${tokensDePulso()}

/* El puente Pulso → Scalar: cada variable del visor apunta a un token.
   Nada de hex acá — el único archivo con hex sigue siendo el de tokens. */
:root, [data-mode="dia"], [data-mode="noche"] {
  --scalar-background-1: var(--bg);
  --scalar-background-2: var(--raised);
  --scalar-background-3: var(--rest);
  --scalar-border-color: var(--line);
  --scalar-color-1: var(--ink);
  --scalar-color-2: var(--body);
  --scalar-color-3: var(--muted);
  --scalar-color-accent: var(--action);
  --scalar-font: Inter, system-ui, sans-serif;
  --scalar-font-code: "JetBrains Mono", ui-monospace, monospace;
}
body { margin: 0; background: var(--bg); }
.sin-internet { font-family: Inter, system-ui, sans-serif; color: var(--body); padding: 2rem; max-width: 36rem; }
</style>
</head>
<body>
<script>
  // El modo lo decide el sistema, como el front antes de tener sesión.
  document.documentElement.dataset.mode =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'noche' : 'dia';
</script>
<noscript><p class="sin-internet">El visor necesita JavaScript. El contrato está en <a href="/docs-json">/docs-json</a>.</p></noscript>
<div id="sin-internet" class="sin-internet" hidden>
  <p>El visor no cargó: necesita internet para bajar Scalar. El contrato OpenAPI está igual en <a href="/docs-json">/docs-json</a>.</p>
</div>
<script id="api-reference" data-url="/docs-json"></script>
<script>
  var s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';
  s.onerror = function () { document.getElementById('sin-internet').hidden = false; };
  document.body.appendChild(s);
</script>
</body>
</html>`;
}
