import type { NextFunction, Request, Response } from 'express';

// Cabeceras de respuesta de la API (#81). Salieron del primer escaneo ZAP
// real contra staging: 61 controles pasados, 0 fallos y 5 avisos, cuatro de
// ellos por cabeceras que faltaban.
//
// Cloudflare pone lo suyo en el borde, pero la API también responde a
// clientes que NO pasan por el borde (el worker interno, un curl desde la
// VPN). Una cabecera de seguridad que solo existe en el proxy es una
// cabecera que se pierde el día que alguien se salta el proxy.

/** Rutas públicas que un sitio de terceros incrusta (el widget de webchat). */
const PUBLICAS_CROSS_ORIGIN = ['/webchat', '/v1/webchat'];

export function cabecerasMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Express anuncia qué framework corre; regalar esa pista no tiene beneficio.
  res.removeHeader('X-Powered-By');

  // Un JSON de un tenant NO puede quedar en un caché compartido. Vale para
  // toda la API: no hay respuesta nuestra que convenga guardar.
  res.setHeader('Cache-Control', 'no-store');

  // El navegador respeta el Content-Type que declaramos en vez de adivinarlo.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Un año de HTTPS obligatorio, PERO nunca en desarrollo: mandarlo sobre
  // http local deja al navegador negándose a volver a entrar al dev server.
  //
  // El detalle que solo se ve en el entorno real: detrás de Cloudflare
  // Tunnel + Traefik, `x-forwarded-proto` llega como **http** —el último
  // salto hacia la app no es TLS— aunque el cliente haya hablado https. Con
  // la condición basada solo en el proto, HSTS no salía NUNCA en staging.
  // Por eso manda el ambiente, que sí sabemos, y el proto queda de refuerzo
  // para cuando la app se sirva directo por TLS.
  const desplegado = ['staging', 'production'].includes(process.env.IAXTI_ENV ?? '');
  if (desplegado || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // El widget de webchat vive incrustado en el sitio del cliente: ahí la
  // política tiene que permitir el uso cruzado. El resto de la API, no.
  const publica = PUBLICAS_CROSS_ORIGIN.some((p) => req.path.startsWith(p));
  res.setHeader('Cross-Origin-Resource-Policy', publica ? 'cross-origin' : 'same-origin');

  next();
}
