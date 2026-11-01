import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Empresas } from '../../components/empresas';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaEmpresas() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Empresas />
    </AppShell>
  );
}
