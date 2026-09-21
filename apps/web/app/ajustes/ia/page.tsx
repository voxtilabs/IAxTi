import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { ConsumoIA } from '../../../components/consumo-ia';
import { Asistente } from '../../../components/asistente';
import { ModoAutonomo } from '../../../components/modo-autonomo';
import { Configurador } from '../../../components/configurador';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function PaginaConsumoIA() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <ConsumoIA />
      <Configurador />
      <Asistente />
      <ModoAutonomo />
    </AppShell>
  );
}
