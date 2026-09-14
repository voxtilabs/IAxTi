import { AppShell, type NavItem } from '../../../components/app-shell';
import { ConsumoIA } from '../../../components/consumo-ia';
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

export default async function PaginaConsumoIA() {
  const nav = await navFromApi();
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <ConsumoIA />
    </AppShell>
  );
}
