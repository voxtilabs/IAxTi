import { AppShell, type NavItem } from '../../components/app-shell';
import { Campanas } from '../../components/campanas';
import { internalApiUrl, publicConfig } from '../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

export default async function PaginaCampanas() {
  let nav: NavItem[] = [];
  try {
    const res = await fetch(`${internalApiUrl()}/v1/me/modules`, { cache: 'no-store' });
    if (res.ok) nav = (await res.json() as Array<{ nav: NavItem[] }>).flatMap((m) => m.nav);
  } catch { /* El shell puede arrancar mientras la API no está disponible. */ }
  return <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}><Campanas /></AppShell>;
}
