# Monitores de Uptime Kuma para IAxTi (#17, la parte operativa)

## Cómo importarlos (5 minutos)

1. Instala Uptime Kuma (Docker: `docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:1`) en el VPS o donde tengas 3001 libre.
2. Entra a la web, crea el usuario admin.
3. Settings → Import / Export → **Import** → elige `uptime-kuma-monitores.json` de este mismo directorio.
4. Settings → Notifications → **Setup Notification** → Telegram (pide el token del bot y tu chat id) → marca los dos monitores.
5. Toque «Test» y confirma que te llegó el mensaje.

## Qué vigilan

- `api-staging.iaxti.cl/health` — exige `"status":"ok"` en el cuerpo.
- `app-staging.iaxti.cl/health` — 200.

Caída = te llega al teléfono en ~1 minuto (intervalo 60 s, 2 reintentos).

## Qué NO incluye (y por qué)

- **Agents**: no tiene dominio público (solo red interna del compose); vigilarlo
  desde afuera requiere exponerlo o poner Kuma dentro del VPS.
- **Producción**: `app.iaxti.cl` y `api.iaxti.cl` están sin DNS
  (`docs/runbooks/DOMINIOS.md`). Cuando tengan DNS, se agregan los dos monitores
  con las mismas formas.
