import { AceptarInvitacion } from '../../../components/aceptar-invitacion';
import { publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

export default async function PaginaInvitacion({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <AceptarInvitacion config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} token={token} />;
}
