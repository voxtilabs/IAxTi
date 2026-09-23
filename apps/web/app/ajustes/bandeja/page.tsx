import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { AjustesBandeja } from '../../../components/ajustes-bandeja';
import { AtajosDeRespuesta } from '../../../components/atajos-de-respuesta';
import { RetencionDelNegocio } from '../../../components/retencion-del-negocio';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function PaginaAjustesBandeja() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      <AjustesBandeja />
      {/* Los atajos van acá y no en su propia pantalla: se escriben el
          mismo día en que se configura cómo se atiende (#460). */}
      <AtajosDeRespuesta />
      {/* Cuánto se guarda va al final: es la decisión que BORRA, y no
          conviene que sea la primera que se encuentra (#480). */}
      <RetencionDelNegocio />
    </AppShell>
  );
}
