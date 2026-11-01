import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Contactos } from '../../components/crm/contactos';
import { internalApiUrl, publicConfig } from '../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaContactos() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Contactos />
    </AppShell>
  );
}
