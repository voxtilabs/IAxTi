'use client';

import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { AvisoResultado, Button, Checkbox, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';
import { SelectorDeAsistente, useAsistenteElegido } from './selector-de-asistente';

/**
 * Qué puede hacer el asistente (#1285).
 *
 * `allowedToolsFor()` cruza lo que el dueño configuró con lo que pide el
 * objetivo desde #315, y no había forma de configurar nada: `allowed_tools`
 * nacía vacío y sin pantalla. Así que cada asistente tenía exactamente las
 * herramientas de su objetivo, y el dueño no podía darle una más aunque
 * quisiera.
 *
 * Dos cosas que esta pantalla NO hace, y es a propósito:
 *
 *  - **No ofrece lo que una ADR cerró.** `calendar.cancel` no aparece. Esto
 *    muestra lo habilitado; no es una puerta para saltarse la ADR-0017.
 *  - **No deja quitar lo que el objetivo exige.** Un asistente de `agendar`
 *    sin ver horarios prometería horas que no puede ver, así que esas llegan
 *    marcadas y bloqueadas, con el motivo al lado.
 *
 * Y el catálogo viene del servidor, no de una constante de acá: una copia en
 * el frontend se desincroniza y nadie se entera hasta que alguien marca una
 * casilla que ya no existe.
 */
type AgenteDto = { id: string; name: string };

// Exportado para que `esqueletos-medidos.spec.ts` TIPE su simulacro: si este
// DTO cambia, la prueba deja de compilar en vez de medir una forma vieja.
export interface QuePuedeHacerDto {
  destinatario: 'cliente' | 'dueño';
  herramientas: {
    nombre: string;
    rotulo: string;
    escribe: boolean;
    modulo: string;
    obligatoria: boolean;
    marcada: boolean;
    disponible: boolean;
    motivo?: string;
  }[];
}

export function QuePuedeHacer() {
  const { session } = useSession();
  const tenant = useSelectedTenant();
  return session && tenant ? <DelNegocio key={`${tenant}|${session.access_token}`} /> : null;
}

function DelNegocio() {
  const { tenant, asistentes, elegido: agente, elegir } = useAsistenteElegido<AgenteDto>();
  return (
    <DelAsistente
      key={agente?.id ?? 'cargando'}
      tenant={tenant}
      asistentes={asistentes}
      agente={agente}
      elegir={elegir}
    />
  );
}

function DelAsistente({
  tenant,
  asistentes,
  agente,
  elegir,
}: {
  tenant: string | null;
  asistentes: AgenteDto[] | null;
  agente: AgenteDto | null;
  elegir: (id: string) => void;
}) {
  const { config, session } = useSession();
  const { carga, recargando, reintentar } = useCarga<QuePuedeHacerDto>(
    agente ? `/agents/${agente.id}/herramientas` : null,
  );
  const [aviso, setAviso] = useState<{ tono: 'error' | 'success'; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  /** Lo que el dueño marcó en esta visita; `null` = lo que vino del servidor. */
  const [tocado, setTocado] = useState<Record<string, boolean>>({});

  const marco = 'pulso-panel w-full max-w-seccion rounded-tarjeta border border-line bg-raised p-6';
  const titulo = 'Qué puede hacer';

  if (carga.estado === 'nada-que-pedir' || !agente || !tenant) return null;
  if (carga.estado === 'cargando') {
    /*
     * 646 MEDIDOS con `esqueletos-medidos`. Acá mide 715,4 px con un asistente
     * de `agendar` —seis de mirar, dos de escribir—, y el marco aporta 82.
     *
     * No apunta a esos 715: en #1281 se midió que el runner de CI da 26 px más
     * por el renderizado de fuentes, así que el valor queda en el punto que
     * está dentro de la tolerancia de 16 px en los dos entornos. Perseguir la
     * medida local deja CI rojo.
     */
    return <PanelCargando etiqueta={titulo} className={marco} alto={646} filas={6} superficie="raised" />;
  }
  if (carga.estado !== 'ok') {
    return (
      <section aria-label={titulo} className={marco}>
        <h2 className="text-base font-semibold text-ink">{titulo}</h2>
        <div className="mt-2">
          <AvisoDeCarga
            carga={carga}
            onReintentar={reintentar}
            sinPermiso="Lo que puede hacer el asistente lo configura quien administra la IA."
          />
        </div>
      </section>
    );
  }

  const { herramientas } = carga.dato;
  const estaMarcada = (n: string, vino: boolean) => tocado[n] ?? vino;
  const miran = herramientas.filter((h) => !h.escribe);
  const escriben = herramientas.filter((h) => h.escribe);

  async function guardar() {
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      // Las obligatorias NO viajan: las pone el objetivo del lado del
      // servidor, y mandarlas acá las convertiría en una copia que se
      // desincroniza el día que el objetivo cambie de herramientas.
      const elegidas = herramientas
        .filter((h) => !h.obligatoria && h.disponible && estaMarcada(h.nombre, h.marcada))
        .map((h) => h.nombre);
      await apiFetch(config, session, tenant, `/agents/${agente!.id}`, {
        method: 'PUT',
        body: JSON.stringify({ allowedTools: elegidas }),
      });
      setTocado({});
      setAviso({ tono: 'success', texto: 'Listo. Lo usa desde la próxima conversación.' });
      reintentar();
    } catch (err) {
      setAviso({ tono: 'error', texto: avisoDe(err).texto });
    } finally {
      setGuardando(false);
    }
  }

  const fila = (h: QuePuedeHacerDto['herramientas'][number]) => (
    <li key={h.nombre} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <label className="inline-flex min-h-control items-center gap-2 text-ink">
        <Checkbox
          checked={estaMarcada(h.nombre, h.marcada)}
          disabled={h.obligatoria || !h.disponible}
          onCheckedChange={(m) => setTocado({ ...tocado, [h.nombre]: m === true })}
        />
        <span className={h.disponible ? '' : 'text-muted'}>{h.rotulo}</span>
      </label>
      {h.obligatoria && <span className="text-xs text-muted">la pide su objetivo</span>}
      {h.motivo && <span className="text-xs text-muted">{h.motivo}</span>}
    </li>
  );

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <p className="flex items-center gap-2">
        <Wrench aria-hidden className="size-4 text-muted" />
        <span className="rotulo">Lo que puede hacer en el negocio</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-body">
        Lo que no marques, no lo hace: ni aunque el cliente se lo pida.
      </p>
      <div className="mt-2">
        <SelectorDeAsistente asistentes={asistentes ?? []} elegidoId={agente.id} onElegir={elegir} />
      </div>

      {aviso && <AvisoResultado tono={aviso.tono}>{aviso.texto}</AvisoResultado>}

      <fieldset className="mt-4">
        <legend className="rotulo">Mirar</legend>
        <ul className="mt-2 flex flex-col gap-1">{miran.map(fila)}</ul>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="rotulo">Dejar algo escrito</legend>
        <ul className="mt-2 flex flex-col gap-1">{escriben.map(fila)}</ul>
      </fieldset>

      <Button className="mt-4" disabled={guardando} onClick={() => void guardar()}>
        {guardando ? 'Guardando…' : 'Guardar'}
      </Button>
    </section>
  );
}
