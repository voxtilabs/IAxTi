import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { ConsumoIA } from '../../../components/consumo-ia';
import { Asistente } from '../../../components/asistente';
import { ModoAutonomo } from '../../../components/modo-autonomo';
import { Evaluaciones } from '../../../components/evaluaciones';
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
      {/* Después del modo autónomo a propósito (#447): la pregunta
          "¿mejoró o empeoró?" se hace cuando ya se cambió algo. */}
      <div className="mt-6">
        <Evaluaciones />
      </div>
    </AppShell>
  );
}
