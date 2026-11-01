import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { PantallaDelAsistente } from '../../../components/agente/pantalla';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

/**
 * «Tu asistente» ES la conversación (#1135, ADR-0025 §1.2).
 *
 * Abrir esta pantalla tiene que sentirse como abrir un chat, no como entrar a
 * un panel de control que además tiene un chat. Los cinco bloques de
 * configuración que estaban acá debajo —más de 4.000 px de alto— se mudaron a
 * `/ajustes/ia/detalle`: no se borran, dejan de competir.
 *
 * `altoCompleto` y no `sinMargen`: el asistente quiere su columna centrada y
 * la barra abierta; lo que necesita es llegar hasta abajo.
 */
export default async function PaginaDelAsistente() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav} altoCompleto>
      <PantallaDelAsistente />
    </AppShell>
  );
}
