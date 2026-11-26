import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { FichaYConversaciones } from '../../../components/crm/ficha-y-conversaciones';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaContacto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <FichaYConversaciones contactId={id} />
    </AppShell>
  );
}
