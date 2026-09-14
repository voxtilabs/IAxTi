import { AppShell, type NavItem } from '../../../components/app-shell';
import { FichaContacto } from '../../../components/crm/ficha-contacto';
import { HistoriaConversaciones } from '../../../components/crm/historia-conversaciones';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

async function navFromApi(): Promise<NavItem[]> {
  try {
    const res = await fetch(`${internalApiUrl()}/v1/me/modules`, { cache: 'no-store' });
    if (!res.ok) return [];
    const modules = (await res.json()) as Array<{ nav: NavItem[] }>;
    return modules.flatMap((m) => m.nav);
  } catch {
    return [];
  }
}

export default async function PaginaContacto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const nav = await navFromApi();
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        <div className="flex-1"><FichaContacto contactId={id} /></div>
        <aside className="lg:w-96"><HistoriaConversaciones contactId={id} /></aside>
      </div>
    </AppShell>
  );
}
