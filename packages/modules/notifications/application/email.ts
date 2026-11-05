import type { PoolClient } from 'pg';
import { createTransport, type Transporter } from 'nodemailer';
import { enteroDeEntorno } from '@iaxti/core';

// El correo del aviso (#55): plantilla sobria en la voz de Pulso. Queda
// APAGADO hasta que el ambiente tenga SMTP (Zoho pendiente): sin
// SMTP_HOST no se envía nada y la campana igual funciona.

let transporter: Transporter | null | undefined;

/**
 * El remitente configurado, o null si no sirve.
 *
 * Antes esto era `SMTP_FROM ?? SMTP_USER`, y el respaldo tenía sentido con
 * un proveedor donde el usuario ES la casilla (Zoho, Google). Con Resend el
 * usuario es literalmente "resend": cada correo habría salido con
 * `From: resend`, que no es una dirección, y el servidor lo rechaza.
 *
 * El modo de fallar importaba: `sendEmail` devuelve un booleano y el
 * consumidor lo trata como mejor-esfuerzo —"un rebote no puede tumbar el
 * aviso de la campana"—, así que el rechazo se habría tragado en silencio.
 * Los correos no llegan, la campana sí, y nadie se entera hasta que alguien
 * dice "nunca me llegó la invitación".
 *
 * Así que se exige explícito, se avisa fuerte, y no se manda nada con un
 * remitente inventado.
 */
function remitente(): string | null {
  const { SMTP_FROM, SMTP_USER } = process.env;
  const candidato = SMTP_FROM?.trim() || SMTP_USER?.trim() || '';
  // Acepta "algo@dominio" y "Nombre <algo@dominio>".
  if (/<[^@\s>]+@[^@\s>]+\.[^@\s>]+>\s*$/.test(candidato) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidato)) {
    return candidato;
  }
  console.error(
    `avisos: SMTP_FROM no es una dirección de correo (${candidato ? `"${candidato}"` : 'vacía'}).\n` +
      '       Los correos NO se están enviando. Con Resend, SMTP_USER es "resend" y no sirve\n' +
      '       de remitente: hay que poner SMTP_FROM con un dominio verificado, por ejemplo\n' +
      '       SMTP_FROM="IAxTi <avisos@iaxti.cl>".',
  );
  return null;
}

function smtp(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return null;
  }
  // Sin remitente válido no se arma el transporte: mejor no mandar que
  // mandar algo que el proveedor rechaza en silencio.
  if (!remitente()) {
    transporter = null;
    return null;
  }
  /**
   * El puerto, por `enteroDeEntorno` y no por `Number(SMTP_PORT ?? 587)`.
   *
   * El compose pasa `SMTP_PORT` sin `:?` ni defecto, así que cuando no está
   * configurada en Dokploy llega como CADENA VACÍA, no como `undefined`. Y
   * `?? ` solo cubre nulos: `'' ?? 587` es `''`, y `Number('')` es **0**. O sea
   * que el transporte se armaba contra el puerto 0, nodemailer no conecta, y el
   * consumidor trata el envío como mejor-esfuerzo —«un rebote no puede tumbar
   * el aviso de la campana»—, así que los correos no salían y nadie se
   * enteraba. Es el mismo modo de falla que el comentario de `remitente()`
   * cuenta de `SMTP_FROM`, por la misma puerta (#810, regla de #613).
   *
   * Lo midió #953: «Compose vacío llega como cadena vacía; `Number(SMTP_PORT ??
   * 587)` produce 0, no 587».
   */
  const puerto = enteroDeEntorno('SMTP_PORT', 587, { min: 1 });
  transporter = createTransport({
    host: SMTP_HOST,
    port: puerto,
    secure: puerto === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

/** El correo del usuario: la última invitación que aceptó en este tenant. */
export async function resolveUserEmail(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const r = await client.query(
    `SELECT email FROM invitations
      WHERE tenant_id = $1 AND accepted_by = $2 AND email IS NOT NULL
      ORDER BY accepted_at DESC LIMIT 1`,
    [tenantId, userId],
  );
  return r.rows[0]?.email ?? null;
}

/** Plantilla sobria (§21): titular, un párrafo, un enlace. Sin adornos. */
/**
 * Los colores de IAxTi, escritos acá y no importados (#1258).
 *
 * `packages/ui` es para la aplicación: trae variables CSS y modo día/noche,
 * y en un correo nada de eso existe —no hay hoja de estilos, no hay
 * `:root`, y la mitad de los clientes descarta lo que no esté en línea—.
 * Repetir cuatro hexadecimales es el precio de que el correo se vea igual en
 * Gmail, en Outlook y en Mail de iPhone.
 */
const MARCA = {
  tinta: '#0C1933',
  accion: '#2F56FF',
  apagado: '#566C8F',
  linea: '#DFE8F7',
  fondo: '#F4F7FD',
} as const;

/** Para que un `&` en el nombre de un negocio no rompa el HTML del correo. */
function escapar(t: string): string {
  return t
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface CorreoRenderizado {
  subject: string;
  html: string;
  /**
   * La versión en texto, que no es un adorno: sin `text/plain` varios
   * filtros suben el puntaje de spam, y hay quien lee el correo en un
   * cliente que no muestra HTML.
   */
  text: string;
}

/**
 * El correo que manda IAxTi (#1258).
 *
 * Antes eran cuatro líneas con estilos sueltos y un enlace azul del
 * navegador: el primer contacto de una persona con el producto —una
 * invitación al equipo— parecía una notificación de sistema, y quien la
 * recibía tenía que decidir si era seguro hacer clic.
 *
 * Tres decisiones que vienen de cómo funcionan los clientes de correo, no
 * del gusto:
 *
 * - **Tablas y estilos en línea.** Gmail borra `<style>`, Outlook usa el
 *   motor de Word. Flexbox y clases no sobreviven el viaje.
 * - **Ninguna imagen obligatoria.** Gmail y Outlook bloquean imágenes por
 *   omisión; un logo que no carga deja un hueco con una cruz. El lockup va
 *   en texto con el azul de la marca y se ve igual con imágenes apagadas.
 * - **El botón es una tabla con fondo**, no un `<a>` con `padding`: en
 *   Outlook el padding de un enlace se ignora y el botón queda plano.
 *
 * Y los colores van explícitos siempre: varios clientes en modo oscuro
 * invierten lo que no está declarado, y un texto sin color definido
 * termina blanco sobre blanco.
 */
export function renderEmail(input: {
  title: string;
  body?: string;
  link?: string;
  appUrl?: string;
  /** Texto del botón; por omisión, el de siempre. */
  cta?: string;
  /**
   * A quién se le escribe. Cambia el pie: a un usuario se le dice cómo
   * elegir sus avisos, y a quien todavía no tiene cuenta eso no le sirve de
   * nada — le sirve saber de dónde salió este correo.
   */
  destinatario?: 'usuario' | 'invitado';
  /** Enlace completo, para lo que no vive en la aplicación (el alta de Zavu). */
  enlaceAbsoluto?: string;
}): CorreoRenderizado {
  const base = input.appUrl ?? process.env.API_URL_PUBLIC?.replace('api', 'app') ?? '';
  const enlace = input.enlaceAbsoluto ?? (input.link ? `${base}${input.link}` : base);
  const cta = input.cta ?? 'Abrir en IAxTi';
  const pie =
    input.destinatario === 'invitado'
      ? 'Recibes este correo porque alguien de ese negocio te invitó a IAxTi. Si no lo esperabas, puedes ignorarlo.'
      : 'Puedes elegir qué avisos recibir en Ajustes → Notificaciones.';
  const titulo = escapar(input.title);
  const cuerpo = input.body ? escapar(input.body) : '';
  const fuente = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:${MARCA.fondo};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MARCA.fondo};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid ${MARCA.linea};border-radius:16px;">
<tr><td style="padding:28px 28px 0;">
<span style="font-family:${fuente};font-size:19px;font-weight:700;color:${MARCA.accion};letter-spacing:-.02em;">IAxTi</span>
</td></tr>
<tr><td style="padding:18px 28px 0;">
<h1 style="margin:0;font-family:${fuente};font-size:21px;line-height:1.3;font-weight:600;color:${MARCA.tinta};">${titulo}</h1>
</td></tr>
${cuerpo ? `<tr><td style="padding:12px 28px 0;"><p style="margin:0;font-family:${fuente};font-size:15px;line-height:1.55;color:${MARCA.apagado};">${cuerpo}</p></td></tr>` : ''}
${
  enlace
    ? `<tr><td style="padding:24px 28px 0;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="background:${MARCA.accion};border-radius:999px;">
<a href="${enlace}" style="display:inline-block;padding:13px 26px;font-family:${fuente};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">${escapar(cta)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:14px 28px 0;">
<p style="margin:0;font-family:${fuente};font-size:12px;line-height:1.5;color:${MARCA.apagado};">Si el botón no funciona, copia esta dirección:<br><span style="color:${MARCA.tinta};word-break:break-all;">${escapar(enlace)}</span></p>
</td></tr>`
    : ''
}
<tr><td style="padding:24px 28px 26px;">
<p style="margin:0;padding-top:18px;border-top:1px solid ${MARCA.linea};font-family:${fuente};font-size:12px;line-height:1.5;color:${MARCA.apagado};">${pie}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [input.title, '', input.body ?? '', '', enlace ? `${cta}: ${enlace}` : '', '', pie]
    .filter((l, i, todo) => !(l === '' && todo[i - 1] === ''))
    .join('\n');

  return { subject: input.title, html, text };
}

export async function sendNotificationEmail(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    title: string;
    body?: string;
    link?: string;
    /**
     * Destinatario explícito, para quien TODAVÍA no es usuario: una
     * invitación va a un correo que aún no tiene cuenta y por lo tanto no
     * se puede resolver desde sus invitaciones aceptadas.
     */
    para?: string;
    /** Los tres de la plantilla con marca (#1258). */
    cta?: string;
    enlaceAbsoluto?: string;
    destinatario?: 'usuario' | 'invitado';
  },
): Promise<boolean> {
  const transport = smtp();
  if (!transport) return false; // sin SMTP todavía: la campana basta
  const email = input.para ?? (await resolveUserEmail(client, input.tenantId, input.userId));
  if (!email) return false;
  const { subject, html, text } = renderEmail(input);
  await transport.sendMail({
    from: remitente()!,
    to: email,
    subject,
    html,
    // El texto plano viaja SIEMPRE (#1258): sin él varios filtros suben el
    // puntaje de spam y quien lee sin HTML recibe un correo vacío.
    text,
  });
  return true;
}

/** Solo para tests. */
export function resetSmtp(): void {
  transporter = undefined;
}
