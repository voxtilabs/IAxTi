import { AppShell } from '../../components/app-shell';
import { navDesdeLaApi } from '../../lib/nav';
import { Oportunidades } from '../../components/crm/oportunidades';
import { internalApiUrl, publicConfig } from '../../lib/config';
import { MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

/**
 * El tablero ocupa la pantalla (#1155).
 *
 * `sinMargen` sin `barraPlegada`: el ancho sí, la barra abierta. Medido antes
 * de esto, como ADMIN con veinte oportunidades en la primera etapa: la página
 * media 6.329 px de alto —las columnas crecen sin tope, así que scrollea la
 * PÁGINA y las cabeceras de etapa se van para arriba— y usaba 1.120 px de los
 * 1.400 disponibles. Un tablero donde no podés ver el nombre de la columna
 * mientras mirás sus tarjetas no es un tablero.
 *
 * Con esto el alto lo fija la ventana y cada columna scrollea por dentro.
 */
export default async function PaginaOportunidades() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav} sinMargen>
      <Oportunidades />
    </AppShell>
  );
}
