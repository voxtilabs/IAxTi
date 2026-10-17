'use client';

import { useState } from 'react';
import { BellRing } from 'lucide-react';
import {
  AvisoResultado,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useSession,
  EstadoVacio,
} from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';

// Con qué plantilla se le recuerda la hora al cliente (#59).
//
// El barrido de recordatorios existía completo y estaba cableado para no
// mandar nada: le faltaba saber QUÉ plantilla usar. Esto es esa decisión, y
// vive en la agenda porque es una decisión de la agenda — qué se le avisa a
// quien tiene hora.
//
// Solo se ofrecen plantillas APROBADAS. Una pendiente elegida hoy es un
// recordatorio que no sale mañana, y el negocio se entera cuando alguien no
// llegó a su hora.

export interface PlantillaDto {
  id: string;
  name: string;
  variables: number;
  body: string;
}

// Exportado para que `esqueletos-medidos.spec.ts` TIPE su simulacro: si
// este DTO cambia, la prueba deja de compilar en vez de seguir midiendo
// contra una forma que ya no existe.
export interface ConfigDto {
  /** Lo ELEGIDO: qué plantilla sale en cada aviso. */
  recordatorios: Record<'24h' | '2h', string | null>;
  /** Lo ELEGIBLE: las plantillas aprobadas del negocio. */
  plantillas: PlantillaDto[];
  zona: string;
  activo: boolean;
}

const AVISOS: Array<{ id: '24h' | '2h'; titulo: string; ayuda: string }> = [
  { id: '24h', titulo: 'Un día antes', ayuda: 'Da tiempo a reagendar si no puede.' },
  { id: '2h', titulo: 'Dos horas antes', ayuda: 'El que más evita que la hora se pierda.' },
];

const NINGUNA = 'ninguna';

export function RecordatoriosDeCita() {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const { carga, recargando, reintentar } = useCarga<ConfigDto>('/agenda/recordatorios');
  /**
   * Solo lo ELEGIDO a mano, y lo del servidor se lee al dibujar (#788).
   *
   * Antes esto se copiaba del servidor a un `useState` dentro de la carga.
   * Copiar obliga a acordarse de copiar otra vez en cada recarga, y una
   * respuesta que llega tarde pisa lo que la persona acababa de elegir.
   */
  const [escritas, setEscritas] = useState<Partial<Record<'24h' | '2h', string>>>({});
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  // 541 px medidos a 360: el texto ocupa más líneas que a 412 (#588).
  const marco = 'pulso-panel rounded-tarjeta border border-line bg-raised p-5 max-[399px]:min-h-[542px]';
  const titulo = 'Recordatorios de cita';

  const datos = carga.estado === 'ok' ? carga.dato : null;
  const elegidas: Record<'24h' | '2h', string> = {
    '24h': escritas['24h'] ?? datos?.recordatorios['24h'] ?? NINGUNA,
    '2h': escritas['2h'] ?? datos?.recordatorios['2h'] ?? NINGUNA,
  };
  const setElegidas = (cambio: (previas: Record<'24h' | '2h', string>) => Record<'24h' | '2h', string>) =>
    setEscritas(cambio(elegidas));

  if (carga.estado === 'nada-que-pedir') return null;
  if (carga.estado === 'cargando') {
    // 431 px MEDIDOS (el panel con una plantilla elegida mide 505). A ojo:
    // 152. Las tres barras son los dos Select y su explicación.
    return <PanelCargando etiqueta={titulo} className={marco} alto={431} filas={3} />;
  }
  if (carga.estado !== 'ok' || datos === null) {
    /**
     * El 403 sigue sin dibujar nada, y eso NO es un descuido heredado.
     *
     * Estaba escrito desde que se escribió el componente —«sin permiso para
     * configurar la agenda: la sección no aparece»— y es la misma convención
     * de los widgets del inicio. Lo que cambia es que antes el `catch` vacío
     * se comía TODO: un 500 o un corte de red desaparecían igual que un 403,
     * así que la sección faltaba y nadie podía saber si era por permisos o
     * porque algo se cayó. Ahora el 403 desaparece y la caída se ve.
     */
    return <AvisoDeCarga carga={carga} onReintentar={reintentar} />;
  }

  const guardar = async () => {
    if (!session || !tenant) return;
    setAviso(null);
    setGuardado(false);
    setGuardando(true);
    try {
      await apiFetch(config, session, tenant, '/agenda/recordatorios', {
        method: 'PUT',
        body: JSON.stringify({
          '24h': elegidas['24h'] === NINGUNA ? null : elegidas['24h'],
          '2h': elegidas['2h'] === NINGUNA ? null : elegidas['2h'],
        }),
      });
      setGuardado(true);
      setEscritas({});
      reintentar();
    } catch (e) {
      // `avisoDe` conserva `code · requestId` (#659, #788).
      setAviso(avisoDe(e).texto);
    } finally {
      setGuardando(false);
    }
  };

  const sinPlantillas = datos.plantillas.length === 0;

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <div className="flex items-center gap-2">
        <BellRing aria-hidden className="size-4 text-action-text" />
        <h2 className="font-display text-seccion font-bold text-ink">Recordatorios de cita</h2>
      </div>
      <p className="mt-1 max-w-prose text-dato text-body">
        La hora que no se recuerda es la hora que no se asiste. Salen por plantilla aprobada, porque
        a esa altura la conversación casi siempre está fuera de la ventana de 24 horas.
      </p>

      {sinPlantillas ? (
        // No se esconde la sección: se dice qué falta y dónde se hace.
        <EstadoVacio compacto className="mt-4" titulo="Todavía no tienes ninguna plantilla aprobada"
          descripcion="Crea una plantilla para recordar la hora al cliente y vuelve: la aprobación de Meta puede tardar."
          accion={{ etiqueta: 'Ajustes → Plantillas', href: '/ajustes/plantillas' }} />
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-4">
            {AVISOS.map((a) => (
              <label key={a.id} className="flex flex-col gap-1">
                <span className="text-dato font-medium text-ink">{a.titulo}</span>
                <span className="text-rotulo text-muted">{a.ayuda}</span>
                <Select
                  value={elegidas[a.id]}
                  onValueChange={(v) => setElegidas((e) => ({ ...e, [a.id]: v }))}
                >
                  <SelectTrigger aria-label={`Plantilla para el recordatorio de ${a.titulo.toLowerCase()}`} className="mt-1 w-full sm:w-96">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NINGUNA}>No mandar este recordatorio</SelectItem>
                    {datos.plantillas.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>

          {/* El contrato con quien escribe la plantilla. Va acá y no en la
              documentación porque una plantilla aprobada por Meta no se
              corrige: se crea otra y se espera de nuevo. */}
          <p className="mt-4 rounded-campo border border-line bg-rest px-4 py-3 text-rotulo text-muted">
            En la plantilla, <strong className="text-body">{'{{1}}'}</strong> es el nombre de quien
            tiene la hora y <strong className="text-body">{'{{2}}'}</strong> es cuándo, en la hora de
            tu negocio. Si tu plantilla usa solo una variable, recibe el nombre.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => void guardar()} disabled={guardando}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </Button>
            {guardado && <span className="text-dato text-good-text">Listo.</span>}
          </div>
        </>
      )}

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}
    </section>
  );
}
