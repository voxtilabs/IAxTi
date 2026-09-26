'use client';

import { useCallback, useEffect, useState } from 'react';
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
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

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

interface PlantillaDto {
  id: string;
  name: string;
  variables: number;
  body: string;
}

interface ConfigDto {
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
  const [tenant, setTenant] = useState<string | null>(null);
  const [datos, setDatos] = useState<ConfigDto | null>(null);
  const [elegidas, setElegidas] = useState<Record<'24h' | '2h', string>>({ '24h': NINGUNA, '2h': NINGUNA });
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const r = await apiFetch<ConfigDto>(config, session, tenant, '/agenda/recordatorios');
      setDatos(r);
      setElegidas({
        '24h': r.recordatorios['24h'] ?? NINGUNA,
        '2h': r.recordatorios['2h'] ?? NINGUNA,
      });
    } catch {
      /* sin permiso para configurar la agenda: la sección no aparece */
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || !datos) return null;

  const guardar = async () => {
    if (!session) return;
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
      await cargar();
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos guardarlo.');
    } finally {
      setGuardando(false);
    }
  };

  const sinPlantillas = datos.plantillas.length === 0;

  return (
    <section
      aria-label="Recordatorios de cita"
      className="pulso-panel rounded-tarjeta border border-line bg-raised p-5"
    >
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
        <p className="mt-4 rounded-campo border border-line bg-rest px-4 py-3 text-dato text-body">
          Todavía no tienes ninguna plantilla aprobada. Créala en{' '}
          <a className="text-action-text" href="/ajustes/plantillas">
            Ajustes → Plantillas
          </a>{' '}
          y vuelve: la aprobación de Meta puede tardar.
        </p>
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
