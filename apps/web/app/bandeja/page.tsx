import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Bandeja } from '../../components/bandeja/bandeja';
import { internalApiUrl, publicConfig } from '../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function PaginaBandeja() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav} sinMargen>
      <Bandeja />
    </AppShell>
  );
}
