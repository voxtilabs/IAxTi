import type { PoolClient } from 'pg';
import { createTransport, type Transporter } from 'nodemailer';

// El correo del aviso (#55): plantilla sobria en la voz de Pulso. Queda
// APAGADO hasta que el ambiente tenga SMTP (Zoho pendiente): sin
// SMTP_HOST no se envía nada y la campana igual funciona.

let transporter: Transporter | null | undefined;

function smtp(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transporter = null;
    return null;
  }
  transporter = createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
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
export function renderEmail(input: { title: string; body?: string; link?: string; appUrl?: string }): {
  subject: string;
  html: string;
} {
  const base = input.appUrl ?? process.env.API_URL_PUBLIC?.replace('api', 'app') ?? '';
  const enlace = input.link ? `${base}${input.link}` : base;
  return {
    subject: input.title,
    html: [
      `<h2 style="font-family:sans-serif;margin:0 0 12px">${input.title}</h2>`,
      input.body ? `<p style="font-family:sans-serif;margin:0 0 16px">${input.body}</p>` : '',
      enlace
        ? `<p style="font-family:sans-serif"><a href="${enlace}">Abrir en IAxTi</a></p>`
        : '',
      `<p style="font-family:sans-serif;font-size:12px;opacity:.6">Puedes elegir qué avisos recibir en Ajustes → Notificaciones.</p>`,
    ].join('\n'),
  };
}

export async function sendNotificationEmail(
  client: PoolClient,
  input: { tenantId: string; userId: string; title: string; body?: string; link?: string },
): Promise<boolean> {
  const transport = smtp();
  if (!transport) return false; // sin SMTP todavía: la campana basta
  const email = await resolveUserEmail(client, input.tenantId, input.userId);
  if (!email) return false;
  const { subject, html } = renderEmail(input);
  await transport.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: email,
    subject,
    html,
  });
  return true;
}

/** Solo para tests. */
export function resetSmtp(): void {
  transporter = undefined;
}
