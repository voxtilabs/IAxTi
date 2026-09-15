# Mapa de dominios de iaxti.cl

Escrito porque el apex **ya está ocupado**: `iaxti.cl` y `www.iaxti.cl` sirven
la landing comercial desde Vercel, y la app vive en otro lado. El día del
lanzamiento alguien va a tocar el DNS con prisa, y sin este mapa puede
llevarse la landing por delante.

Verificado el 2026-09-15 contra la zona en producción.

## Quién sirve qué

| Nombre | Quién lo sirve | Qué es | Estado |
|---|---|---|---|
| `iaxti.cl` | Vercel (tras Cloudflare) | Redirige 307 a `www` | **en uso** |
| `www.iaxti.cl` | Vercel (tras Cloudflare) | Landing comercial (Next.js) | **en uso** |
| `app-staging.iaxti.cl` | VPS · Dokploy | La app (web) de staging | **en uso** |
| `api-staging.iaxti.cl` | VPS · Dokploy | La API de staging | **en uso** |
| `dokploy.iaxti.cl` | VPS · túnel de Cloudflare | Panel de Dokploy, tras Access | **en uso** |
| `app.iaxti.cl` | VPS · Dokploy | La app de producción | **libre** (sin DNS) |
| `api.iaxti.cl` | VPS · Dokploy | La API de producción | **libre** (sin DNS) |

## La regla que no se rompe

**El apex y `www` son de la landing.** La app NUNCA va ahí: entra por
subdominios propios. Si algún día se quiere `iaxti.cl/app`, eso es un proxy
en el borde, no un cambio de DNS — y hay que diseñarlo, porque partir el
mismo hostname entre dos orígenes es donde nacen los incidentes difíciles.

## Producción, cuando toque

1. `app.iaxti.cl` y `api.iaxti.cl` como CNAME al túnel del VPS, **proxied**.
2. `PROD_BASE_URL` = `https://api.iaxti.cl` en los secrets del environment
   `production` (lo usan el smoke de la release y el rollback).
3. `CORS_ORIGINS` = `https://app.iaxti.cl` — lista cerrada, sin comodines.
4. `API_URL_PUBLIC` = `https://api.iaxti.cl`.
5. El webhook del proveedor de canales apunta a
   `https://api.iaxti.cl/webhooks/channels/{accountId}`. **Mientras no se
   reapunte, los mensajes siguen llegando a staging y nadie se entera hasta
   que un cliente reclama.**

## Lo que hay que arreglar en Cloudflare antes

Las reglas de rate limit sobre `/api/*` y `/webhooks/*` (#16) están armadas
**por zona**, así que también le aplican a `www.iaxti.cl`. Hoy es inofensivo
—la landing no tiene endpoints propios, solo redirecciones de trailing
slash—, pero el día que tenga un formulario con su `/api/contacto`, un
límite pensado para la API del producto va a empezar a **bloquear leads**.

**Acotar esas reglas por hostname** (`api.iaxti.cl` y `api-staging.iaxti.cl`)
antes de que la landing crezca. Es un cambio de dos minutos ahora y un
incidente comercial después.

## El número de WhatsApp de la landing

El CTA de `www.iaxti.cl` es un enlace `wa.me` a un número real del negocio.
Ese número, cuando se conecte al producto, va a **producción**: la regla
vigente es que en staging jamás se conecta un número real. Para staging va
el número de prueba del proveedor.
