import { AppShell, type NavItem } from '../components/app-shell';
import { internalApiUrl, publicConfig } from '../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

async function navFromApi(): Promise<NavItem[]> {
  try {
    const res = await fetch(`${internalApiUrl()}/v1/me/modules`, { cache: 'no-store' });
    if (!res.ok) return [];
    const modules = (await res.json()) as Array<{ nav: NavItem[] }>;
    return modules.flatMap((m) => m.nav);
  } catch {
    return []; // la API puede no estar en build local: el shell degrada
  }
}

export default async function Home() {
  const nav = await navFromApi();
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      {/* Estado vacío según Pulso: qué va a aparecer y la acción que lo provoca */}
      <div className="rounded-tarjeta border border-line bg-raised p-8">
        <p className="rotulo">Bandeja</p>
        <h2 className="mt-2 text-xl font-bold text-ink">
          Aquí van a llegar las conversaciones de tu negocio
        </h2>
        <p className="mt-2 max-w-prose text-body">
          Cuando conectes WhatsApp o actives el chat de tu sitio, cada mensaje aparecerá en esta
          bandeja con su contacto y su historia. La bandeja completa llega con la siguiente parte
          de esta fase.
        </p>
      </div>
    </AppShell>
  );
}
