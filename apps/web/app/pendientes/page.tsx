import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Pendientes } from '../../components/crm/pendientes';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';

export default async function PaginaPendientes() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Pendientes />
    </AppShell>
  );
}
