import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Bandeja } from '../../components/bandeja/bandeja';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaBandeja() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav} sinMargen barraPlegada>
      <Bandeja />
    </AppShell>
  );
}
