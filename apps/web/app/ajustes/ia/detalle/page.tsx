import { AppShell } from '../../../../components/app-shell';
import { navDesdeLaApi } from '../../../../lib/nav';
import { ConsumoIA } from '../../../../components/consumo-ia';
import { Asistente } from '../../../../components/asistente';
import { ModoAutonomo } from '../../../../components/modo-autonomo';
import { Evaluaciones } from '../../../../components/evaluaciones';
import { LogroDelObjetivo } from '../../../../components/logro-del-objetivo';
import { Configurador } from '../../../../components/configurador';
import { AjustesDeIa } from '../../../../components/ajustes-de-ia';
import { PorQueLaIaNoTrabaja } from '../../../../components/por-que-la-ia-no-trabaja';
import { internalApiUrl, publicConfig } from '../../../../lib/config';
import { EncabezadoDePagina } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';

/**
 * Lo que quedó configurado (#1135).
 *
 * Estos paneles vivían debajo del chat. El dueño del producto los probó así y
 * dijo que eran demasiada información: lo que quiere es que «Tu asistente»
 * sea como abrir ChatGPT, y desde ahí configurar.
 *
 * No se borran, se mudan. El agente PROPONE y el humano decide (ADR-0025,
 * ADR-0017), así que sigue haciendo falta dónde ver qué quedó: un chat que
 * configura sin superficie que muestre el resultado no es auditable. Lo que
 * cambia es que dejan de competir con la conversación.
 *
 * El orden es el mismo que tenían, con sus motivos intactos: la causa antes
 * del gráfico en cero (#614), el proveedor antes del configurador (#536), el
 * logro antes de «¿mejoró o empeoró?» (#460, #447) y el consumo al final.
 */
export default async function PaginaDetalleDelAsistente() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} nav={nav}>
      <EncabezadoDePagina
        rotulo="Asistente"
        titulo="Lo que quedó configurado"
        apoyo="Lo que tiene puesto hoy. Para cambiarlo, pídeselo conversando."
      />
      <PorQueLaIaNoTrabaja />
      <AjustesDeIa />
      <Configurador />
      <Asistente />
      <ModoAutonomo />
      <LogroDelObjetivo />
      <div className="mt-6">
        <Evaluaciones />
      </div>
      <ConsumoIA />
    </AppShell>
  );
}
