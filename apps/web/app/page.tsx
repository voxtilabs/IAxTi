import { AppShell } from '../components/app-shell';
import { navDesdeLaApi, widgetsDesdeLaApi } from '../lib/nav';
import { PuestaEnMarcha } from '../components/puesta-en-marcha';
import { internalApiUrl, publicConfig } from '../lib/config';

export const dynamic = 'force-dynamic';


export default async function Home() {
  // Las dos salen de `GET /modules/catalogo`, y Next dedupe la petición: un solo
  // viaje. Los widgets los declara cada módulo en su manifiesto (#517), así
  // que un módulo apagado se lleva el suyo sin desplegar.
  const api = internalApiUrl();
  const [nav, widgets] = await Promise.all([navDesdeLaApi(api), widgetsDesdeLaApi(api)]);
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <PuestaEnMarcha widgets={widgets} />
    </AppShell>
  );
}
