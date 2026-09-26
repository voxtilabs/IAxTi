import { LoginCard, MARCA_LOCKUP_SVG } from '@iaxti/ui/react';
import { publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <LoginCard
      config={publicConfig()}
      marcaSvg={MARCA_LOCKUP_SVG}
      titulo="Panel de IAxTi"
      subtitulo="Solo para quien opera la plataforma."
      // Los redirects de GoTrue NO llegan a este dominio: fuerza `redirect_to`
      // al site_url aunque la URL esté en la allowlist (#113). Así que acá no
      // se ofrece Google ni se dice "abre el enlace" — las dos cosas dejarían
      // al operador en la app de clientes. Se entra con el código.
      recibeLosRedirects={false}
    />
  );
}
