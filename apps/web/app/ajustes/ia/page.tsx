import { AppShell } from '../../../components/app-shell';
import { navDesdeLaApi } from '../../../lib/nav';
import { ConsumoIA } from '../../../components/consumo-ia';
import { Asistente } from '../../../components/asistente';
import { ModoAutonomo } from '../../../components/modo-autonomo';
import { Evaluaciones } from '../../../components/evaluaciones';
import { LogroDelObjetivo } from '../../../components/logro-del-objetivo';
import { Configurador } from '../../../components/configurador';
import { AjustesDeIa } from '../../../components/ajustes-de-ia';
import { PorQueLaIaNoTrabaja } from '../../../components/por-que-la-ia-no-trabaja';
import { internalApiUrl, publicConfig } from '../../../lib/config';
import { EncabezadoDePagina, MARCA_LOCKUP_SVG } from '@iaxti/ui/react';

export const dynamic = 'force-dynamic';


export default async function PaginaConsumoIA() {
  const nav = await navDesdeLaApi(internalApiUrl());
  return (
    <AppShell config={publicConfig()} marcaSvg={MARCA_LOCKUP_SVG} nav={nav}>
      {/* La pantalla que ES el producto no tenía encabezado (#1125). Abría
          directo con el panel de diagnóstico, y el único titular con peso de
          página estaba a dos tercios hacia abajo diciendo «Consumo del
          asistente»: la pantalla central se presentaba sin nombre y lo único
          que la nombraba en grande era su facturación.
          El comentario de `EncabezadoDePagina` ya lo decía entre los ejemplos
          que #398 venía a arreglar —«el asistente abriendo con h2»— y quedó
          sin tocar.
          El apoyo es la frase que estaba enterrada en `asistente.tsx`, que es
          lo que esta pantalla tiene que contestar primero. */}
      <EncabezadoDePagina
        rotulo="Asistente"
        titulo="Tu asistente"
        apoyo="Contesta en WhatsApp con lo que tú le diste: tu catálogo, tus precios, tu agenda. Nunca inventa un dato que no pudo confirmar, y cuando no puede resolver algo te pasa la conversación."
      />
      {/* Antes del consumo (#614): un gráfico en cero es el síntoma y la causa
          se lee primero. Si falta una credencial, todo lo demás de esta página
          es configuración de algo que no va a correr. */}
      <PorQueLaIaNoTrabaja />
      {/* El proveedor único va arriba del configurador (#536): decide DÓNDE
          corre todo lo demás, así que elegirlo después de armar el asistente
          sería armarlo dos veces. */}
      <AjustesDeIa />
      <Configurador />
      <Asistente />
      <ModoAutonomo />
      {/* Lo que el asistente consiguió va antes de "¿mejoró o empeoró?":
          primero si sirve para lo suyo, después si la última configuración
          lo hizo mejor o peor (#460). */}
      <LogroDelObjetivo />
      {/* Después del modo autónomo a propósito (#447): la pregunta
          "¿mejoró o empeoró?" se hace cuando ya se cambió algo. */}
      <div className="mt-6">
        <Evaluaciones />
      </div>
      {/* El consumo baja al final.
          Estaba segundo, y como es el primer bloque con título grande, la
          página del asistente se leía llamándose «Consumo del asistente»: el
          protagonista del producto presentado como una pantalla de
          facturación. Lo que esta página tiene que contestar primero es «qué
          hace por mí y cómo lo configuro», y recién después «cuánto va
          gastando».
          Esto NO contradice a #614, que pide que la causa se lea antes que un
          gráfico en cero: `PorQueLaIaNoTrabaja` sigue arriba de todo, y el
          gráfico ahora está más abajo todavía. */}
      <ConsumoIA />
    </AppShell>
  );
}
