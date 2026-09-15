/* Widget de IAxTi (#46). Instalación:
 * <script src="https://TU-APP/webchat.js" data-widget="TOKEN" async></script>
 *
 * Esto corre en el sitio DEL CLIENTE. Un error acá no rompe nuestra app:
 * rompe la página de quien nos contrató. Por eso el snippet es defensivo
 * hasta la exageración y no hace nada que no necesite hacer.
 *
 * El snippet solo pinta el botón y el iframe: todo lo demás vive en la app
 * (mismo origen que la API permitida por CORS), así el sitio del cliente
 * no necesita permisos ni claves. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var widgetId = script.getAttribute('data-widget');
  if (!widgetId) return;

  // Dos veces el mismo snippet —pasa siempre: gestor de etiquetas MÁS
  // pegado a mano— pintaría dos botones encima del sitio del cliente.
  if (window.__iaxtiWebchat) return;
  window.__iaxtiWebchat = true;

  var origin = new URL(script.src).origin;

  /* La página donde está el visitante, SIN query ni fragmento: ahí es donde
   * los sitios meten correos, tokens de sesión y códigos de campaña. Nos
   * basta saber en qué página está para dar contexto; el resto es PII que
   * no pedimos y no queremos guardar. */
  function paginaLimpia() {
    try {
      var u = new URL(window.location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

  var url =
    origin + '/webchat/' + encodeURIComponent(widgetId) +
    '?page=' + encodeURIComponent(paginaLimpia());

  var iframe = null;
  var abierto = false;

  var boton = document.createElement('button');
  boton.type = 'button';
  boton.setAttribute('aria-label', 'Abrir el chat');
  boton.style.cssText =
    'position:fixed;bottom:20px;right:20px;width:60px;height:60px;border:0;border-radius:999px;' +
    'background:#3D5AFE;color:#fff;font-size:26px;cursor:pointer;z-index:2147483001;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.25);';
  boton.textContent = '💬';

  boton.addEventListener('click', function () {
    /* El iframe se crea al PRIMER clic, no al cargar la página. Antes se
     * cargaba el chat entero en cada visita aunque nadie lo abriera: ancho
     * de banda del cliente y una sesión creada por alguien que solo pasaba. */
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.title = 'Chat';
      iframe.style.cssText =
        'position:fixed;bottom:96px;right:20px;width:360px;height:520px;max-width:calc(100vw - 32px);' +
        'max-height:calc(100vh - 120px);border:0;border-radius:22px;z-index:2147483000;display:none;' +
        'box-shadow:0 12px 40px rgba(0,0,0,.22);background:transparent;';
      document.body.appendChild(iframe);
    }
    abierto = !abierto;
    iframe.style.display = abierto ? 'block' : 'none';
    boton.textContent = abierto ? '×' : '💬';
    boton.setAttribute('aria-label', abierto ? 'Cerrar el chat' : 'Abrir el chat');
  });

  /* Con `async` el script puede correr ANTES de que exista <body> (si el
   * cliente lo pone en el <head>, que es lo que recomienda medio internet).
   * `document.body.appendChild` sobre null es un TypeError en la consola de
   * SU sitio. */
  function montar() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', montar, { once: true });
      return;
    }
    document.body.appendChild(boton);
  }
  montar();
})();
