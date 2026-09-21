import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { FichaContacto } from '../../../components/crm/ficha-contacto';
import { HistoriaConversaciones } from '../../../components/crm/historia-conversaciones';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function PaginaContacto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        <div className="flex-1"><FichaContacto contactId={id} /></div>
        <aside className="lg:w-96"><HistoriaConversaciones contactId={id} /></aside>
      </div>
    </AppShell>
  );
}
