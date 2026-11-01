import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { Campos } from '../../../components/campos';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaCampos() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Campos />
    </AppShell>
  );
}
