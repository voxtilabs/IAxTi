/* Widget de IAxTi (#46). Instalación:
 * <script src="https://TU-APP/webchat.js" data-widget="TOKEN" async></script>
 * El snippet solo pinta el botón y el iframe: todo lo demás vive en la app
 * (mismo origen que la API permitida por CORS), así el sitio del cliente
 * no necesita permisos ni claves. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var widgetId = script.getAttribute('data-widget');
  if (!widgetId) return;
  var origin = new URL(script.src).origin;
  var url =
    origin + '/webchat/' + encodeURIComponent(widgetId) +
    '?page=' + encodeURIComponent(window.location.href);

  var abierto = false;
  var iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.title = 'Chat';
  iframe.style.cssText =
    'position:fixed;bottom:96px;right:20px;width:360px;height:520px;max-width:calc(100vw - 32px);' +
    'max-height:calc(100vh - 120px);border:0;border-radius:22px;z-index:2147483000;display:none;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.22);background:transparent;';

  var boton = document.createElement('button');
  boton.type = 'button';
  boton.setAttribute('aria-label', 'Abrir el chat');
  boton.style.cssText =
    'position:fixed;bottom:20px;right:20px;width:60px;height:60px;border:0;border-radius:999px;' +
    'background:#3D5AFE;color:#fff;font-size:26px;cursor:pointer;z-index:2147483001;' +
    'box-shadow:0 8px 24px rgba(0,0,0,.25);';
  boton.textContent = '💬';
  boton.addEventListener('click', function () {
    abierto = !abierto;
    iframe.style.display = abierto ? 'block' : 'none';
    boton.textContent = abierto ? '×' : '💬';
    boton.setAttribute('aria-label', abierto ? 'Cerrar el chat' : 'Abrir el chat');
  });

  document.body.appendChild(iframe);
  document.body.appendChild(boton);
})();
