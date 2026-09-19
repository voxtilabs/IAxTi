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
      // Sin Google acá: GoTrue fuerza el redirect al site_url (#113) y el
      // operador terminaría en la app de clientes. El código del correo
      // entra igual y no depende de ningún redirect.
      conGoogle={false}
    />
  );
}
