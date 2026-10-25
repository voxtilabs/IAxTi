# webchat

El canal del widget público: un visitante anónimo escribe desde el sitio del
negocio y la conversación entra a la bandeja como cualquier otra.

## La mina que no hay que pisar (#1017)

Las rutas públicas del widget viven **FUERA de `/v1`**, como `/health`:

    POST /webchat/{widgetId}/sessions
    POST /webchat/{widgetId}/messages
    GET  /webchat/{widgetId}/messages
    GET  /webchat/{widgetId}/config

Pegarle a `/v1/webchat/...` devuelve el 404 genérico del formato único, que es
**indistinguible** del 404 mudo de `widgetValido` (#821: hacia el visitante no
se explica nada, a propósito) — y eso descarrila a quien desarrolla hacia el
módulo, el dominio o RLS cuando el problema es la URL. Costó media hora la
primera vez; por eso este README.

Por qué sin `/v1`: el snippet del widget está publicado en los sitios de los
clientes y su contrato no se versiona con la API del panel. El catálogo
generado publica las rutas correctas (`GET /webchat/{widgetId}/config`).
