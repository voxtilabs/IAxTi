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
    />
  );
}
