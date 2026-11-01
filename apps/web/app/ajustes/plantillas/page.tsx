import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { Plantillas } from '../../../components/plantillas';
import { internalApiUrl, publicConfig } from '../../../lib/config';

export const dynamic = 'force-dynamic';


export default async function PaginaPlantillas() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <Plantillas />
    </AppShell>
  );
}
