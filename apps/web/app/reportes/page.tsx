import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Reportes } from '../../components/reportes';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaReportes() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Reportes />
    </AppShell>
  );
}
