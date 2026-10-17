'use client';

import { useState, type FormEvent } from 'react';
import { Archive } from 'lucide-react';
import { AvisoResultado, Button, Input, useSession } from '@iaxti/ui/react';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';

/**
 * Cuánto tiempo guarda el negocio sus conversaciones (#480).
 *
 * `PUT /settings/retencion` existe desde #77 y no la llamaba nadie: la
 * bandeja mostraba desde cuándo NO hay historial y el negocio no podía
 * decidir nada. Acortar la retención es de las pocas decisiones que
 * BORRAN datos, y la ley de datos personales la supone posible.
 *
 * Nunca se puede alargar más que el plan: eso lo decide el servidor, que
 * es el único que sabe qué plan tiene este negocio hoy.
 */
// Exportado para que `esqueletos-medidos.spec.ts` TIPE su simulacro: si
// este DTO cambia, la prueba deja de compilar en vez de seguir midiendo
// contra una forma que ya no existe.
export interface RetencionDto {
  months: number | null;
  cutoff: string | null;
  deferredUntil: string | null;
}

interface GuardadoDto {
  saved: boolean;
  purgeNotice: { count: number; firstPurgeAt: string } | null;
}

export function RetencionDelNegocio() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  // Los cinco estados por el camino compartido (#788). Lo que había acá era
  // `datos`, `cargando` y `aviso` por separado: tres fuentes de verdad para
  // una sola pregunta, y la combinación «datos en null, cargando en false»
  // significaba dos cosas distintas según por dónde se hubiera llegado.
  const { carga, recargando, reintentar } = useCarga<RetencionDto>('/settings/retencion');
  /**
   * `null` es «no lo tocó todavía», y por eso no hay efecto que sincronice.
   *
   * La versión anterior copiaba el valor del servidor a un `useState` dentro
   * de la carga. Eso obliga a recordar copiarlo de nuevo en cada recarga, y si
   * una respuesta vieja llega tarde, pisa lo que la persona estaba
   * escribiendo. Guardando solo lo ESCRITO, el campo muestra el dato del
   * servidor hasta que alguien escribe, y a partir de ahí lo suyo manda.
   */
  const [escrito, setEscrito] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [purga, setPurga] = useState<GuardadoDto['purgeNotice']>(null);

  const datos = carga.estado === 'ok' ? carga.dato : null;
  const valor = escrito ?? (datos?.months === null || datos === null ? '' : String(datos.months));

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      const r = await apiFetch<GuardadoDto>(config, session, tenant, '/settings/retencion', {
        method: 'PUT',
        body: JSON.stringify({ months: valor.trim() === '' ? null : Number(valor) }),
      });
      // Cuántas conversaciones se van a borrar y CUÁNDO: la purga se
      // difiere 30 días justamente para que se pueda deshacer.
      setPurga(r.purgeNotice);
      setAviso(null);
      setEscrito(null);
      reintentar();
    } catch (err) {
      // `avisoDe` conserva `code · requestId` (#659, #788): era
      // `(err as Error).message`, que tira justo el dato con el que alguien
      // puede ir a buscar en los registros qué pasó.
      setAviso(avisoDe(err).texto);
    } finally {
      setGuardando(false);
    }
  }

  // El marco va en una constante porque lo usan los TRES estados, y si el
  // esqueleto no lleva el mismo `mt-10 border-t pt-8` salta igual que antes
  // —con el alto de adentro clavado al milímetro—.
  // A 360 px el formulario envuelve: 303 px medidos, frente a 224 a 412 px.
  // Ambos estados reservan ese marco en teléfonos estrechos (#588).
  const marco = 'mt-10 border-t border-line pt-8 max-[399px]:min-h-[303px]';
  const titulo = 'Cuánto se guardan las conversaciones';

  /**
   * Los cinco estados, cada uno con lo suyo (#788).
   *
   * Antes esto eran dos `if` encadenados sobre `datos` y `cargando`, y el caso
   * «falló la carga» salía por el mismo agujero que «no hay negocio»: un
   * `return null` que se tragaba el error entero. Con el estado nombrado, cada
   * rama tiene que decidirse a mano y ninguna se cae por descarte.
   */
  if (carga.estado === 'nada-que-pedir') return null;
  if (carga.estado === 'cargando') {
    // 159 px MEDIDOS contra el panel cargado, no estimados: el panel entero
    // mide 224 px y el marco se come 65. Lo comprueba
    // `esqueletos-medidos.spec.ts` comparando los dos estados del MISMO
    // locator, con 16 px de tolerancia.
    //
    // El primer valor que puse acá fue 128, a ojo. Estaba 31 px corto, que es
    // exactamente el tipo de error que el criterio del issue prohíbe.
    return <PanelCargando etiqueta={titulo} className={marco} alto={159} />;
  }
  if (carga.estado !== 'ok' || datos === null) {
    /**
     * Sin permiso y caída se ven por el camino compartido, y se ven distinto.
     *
     * Acá había un `AvisoResultado` armado a mano que mostraba `err.message`
     * pelado, sin `code · requestId` y sin forma de reintentar. Y antes de
     * #897 no mostraba nada: el `catch` llenaba `aviso` y el `return null` de
     * abajo lo tiraba, así que una caída se veía igual que «esta
     * configuración no existe» — y la retención es cuánto tiempo se guardan
     * los datos de los clientes de este negocio.
     *
     * El 403 no lleva frase: quien no tiene `tenant.settings` no decide la
     * retención, y una sección que explica lo que no vas a poder hacer es
     * ruido. Lo que NO puede pasar —y pasaba— es que lleve «Reintentar».
     */
    return (
      <section aria-label={titulo} className={marco}>
        <h2 className="text-base font-bold text-ink">{titulo}</h2>
        <div className="mt-2">
          <AvisoDeCarga carga={carga} onReintentar={reintentar} />
        </div>
      </section>
    );
  }

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <p className="flex items-center gap-2">
        <Archive aria-hidden className="size-4 text-muted" />
        <h2 className="text-base font-bold text-ink">{titulo}</h2>
      </p>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Tu plan guarda {datos.months === null ? 'sin límite' : `${datos.months} meses`}. Puedes
        acortarlo si prefieres guardar menos — nunca alargarlo por encima del plan.
        {datos.cutoff && (
          <> Hoy el corte está en <span className="dato">{datos.cutoff}</span>.</>
        )}
      </p>

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      <form onSubmit={guardar} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Guardar por
          <span className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              className="dato w-24"
              placeholder="lo del plan"
              value={valor}
              onChange={(e) => setEscrito(e.target.value)}
            />
            <span className="text-body">meses</span>
          </span>
          <span className="text-xs text-muted">
            En blanco vuelve a lo que da el plan.
          </span>
        </label>
        <Button type="submit" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>

      {purga && (
        // Se dice ANTES de que pase y con fecha: la purga se difiere 30
        // días a propósito, para que haya tiempo de arrepentirse.
        <p className="mt-3 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text">
          Con ese plazo, {purga.count}{' '}
          {purga.count === 1 ? 'conversación se eliminará' : 'conversaciones se eliminarán'} a partir
          del <span className="dato">{purga.firstPurgeAt}</span>. Hasta entonces puedes volver a
          alargarlo y no se borra nada.
        </p>
      )}
      {purga === null && datos.deferredUntil && (
        <p className="mt-3 text-sm text-muted">
          Hay una purga pendiente para el <span className="dato">{datos.deferredUntil}</span>.
        </p>
      )}
    </section>
  );
}
