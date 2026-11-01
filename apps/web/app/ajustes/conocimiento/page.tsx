import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { Conocimiento } from '../../../components/conocimiento';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaConocimiento() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Conocimiento />
    </AppShell>
  );
}
