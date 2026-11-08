# Los correos de inicio de sesión

**Estos cinco correos NO salen de IAxTi.** Los manda Supabase Auth con sus
propias plantillas, y por eso el branding que `notifications/email.ts` le puso
a los avisos no los alcanza: son dos caminos distintos que terminan en el mismo
buzón.

Así llegaba el de entrar, el 6 de noviembre:

> **Your sign-in link**
> Follow the link below to sign in. This link expires shortly and can only be
> used once.
> Sign in

En inglés, sin marca, y con el remitente correcto —`avisos@m.iaxti.cl`— porque
el SMTP propio ya está configurado. Lo único que faltaba eran las plantillas.

## Dónde se pegan

Panel de Supabase → **Authentication → Emails**, y cada archivo va en su
plantilla:

| Archivo | Plantilla de Supabase | Asunto que hay que poner |
|---|---|---|
| `magic-link.html` | Magic Link | `Entra a IAxTi` |
| `invitacion.html` | Invite user | `Te invitaron a IAxTi` |
| `confirmar-correo.html` | Confirm signup | `Confirma tu correo` |
| `cambio-de-correo.html` | Change Email Address | `Confirma tu correo nuevo` |
| `recuperar-clave.html` | Reset Password | `Cambia tu contraseña` |

El asunto también se edita ahí: una plantilla en español con el asunto en
inglés deja el problema a medias, porque el asunto es lo único que se ve en la
bandeja antes de abrir.

## Por API, si se prefiere no entrar al panel

Con un token de acceso personal de Supabase y la referencia del proyecto:

```sh
curl -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg c "$(cat docs/correos-de-auth/magic-link.html)" \
        '{mailer_subjects_magic_link: "Entra a IAxTi", mailer_templates_magic_link_content: $c}')"
```

Las otras cuatro usan `mailer_templates_invite_content`,
`mailer_templates_confirmation_content`,
`mailer_templates_email_change_content` y
`mailer_templates_recovery_content`, cada una con su `mailer_subjects_*`.

## Lo que comparten con el resto de los correos, y por qué

Mismo diseño que `renderEmail`: tablas y estilos en línea —porque ningún
cliente de correo garantiza flexbox—, sin imágenes, el botón hecho con una
tabla y una celda de fondo, y la dirección completa visible debajo para quien
tenga los botones bloqueados.

Los mismos cinco colores medidos del producto: tinta `#0C1933`, acción
`#2F56FF`, apagado `#566C8F`, línea `#DFE8F7`, fondo `#F4F7FD`.

## Lo que dicen, y por qué así

- **El de entrar avisa que el enlace sirve una vez y caduca en una hora**, y
  además dice qué pasa si no lo pediste: «sin tocar el botón, nadie entra con
  este correo». Un correo de acceso que no explica eso deja a cualquiera
  dudando de si lo hackearon.
- **El de invitación aclara de quién viene** —«alguien de tu equipo te sumó»— y
  que se ignore si no se esperaba. Es el único de los cinco que le llega a
  alguien que puede no conocer IAxTi, así que su pie lo nombra.
- **El de contraseña dice que, si no lo pediste, la tuya sigue siendo la
  misma.** Es lo que la persona necesita saber en ese segundo.

## Variables

Son las de Supabase y hay que dejarlas tal cual: `{{ .ConfirmationURL }}` en
los cinco y `{{ .NewEmail }}` en el de cambio de correo. Cambiarlas por una URL
escrita a mano deja el correo bonito y el enlace muerto.
