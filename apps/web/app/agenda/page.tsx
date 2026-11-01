import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Agenda } from '../../components/agenda';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaAgenda() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Agenda />
    </AppShell>
  );
}
