import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { Automatizaciones } from '../../../components/automatizaciones';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaAutomatizaciones() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Automatizaciones />
    </AppShell>
  );
}
