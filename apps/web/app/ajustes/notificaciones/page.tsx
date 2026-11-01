import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { PreferenciasAvisos } from '../../../components/preferencias-avisos';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaPreferenciasAvisos() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <PreferenciasAvisos />
    </AppShell>
  );
}
