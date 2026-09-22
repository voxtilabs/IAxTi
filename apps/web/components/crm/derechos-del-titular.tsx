'use client';

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { AvisoResultado, Button, Input, useSession } from '@iaxti/ui/react';
import { selectedTenant } from '../tenant-switcher';
import { apiFetch } from '../../lib/api';

/**
 * Los derechos del titular de los datos (#447, Ley 21.719).
 *
 * Exportar y suprimir estaban implementados desde el principio —con su
 * auditoría, su borrado de adjuntos en R2 y su lista de lo que se conserva
 * a propósito— y sin ninguna forma de ejercerlos: dos rutas de la API que
 * no llamaba nadie. Una obligación legal construida y no ejercible es peor
 * que una pendiente, porque parece resuelta.
 *
 * No se esconde detrás de un menú: quien recibe una solicitud de una
 * persona tiene que encontrarla mirando su ficha.
 */
interface ResultadoSupresion {
  mensajesBorrados: number;
  identidadesBorradas: number;
  actividadesBorradas: number;
  ejecucionesVaciadas: number;
  adjuntosR2: string[];
  conservado: string[];
}

export function DerechosDelTitular({ contactId, nombre }: { contactId: string; nombre: string | null }) {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [ocupado, setOcupado] = useState<'exportar' | 'suprimir' | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoSupresion | null>(null);

  if (!tenant) return null;

  const exportar = async () => {
    if (!session) return;
    setAviso(null);
    setOcupado('exportar');
    try {
      const datos = await apiFetch<Record<string, unknown>>(
        config,
        session,
        tenant,
        `/contacts/${contactId}/titular`,
      );
      // Se descarga en el navegador: el JSON es para entregárselo a la
      // persona, así que tiene que salir de acá en un archivo, no quedarse
      // en una pantalla que hay que copiar a mano.
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `datos-${nombre?.replace(/\s+/g, '-').toLowerCase() ?? contactId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos armar la exportación.');
    } finally {
      setOcupado(null);
    }
  };

  const suprimir = async () => {
    if (!session || !motivo.trim()) return;
    setAviso(null);
    setOcupado('suprimir');
    try {
      setResultado(
        await apiFetch<ResultadoSupresion>(
          config,
          session,
          tenant,
          `/contacts/${contactId}/titular/suprimir`,
          { method: 'POST', body: JSON.stringify({ motivo: motivo.trim() }) },
        ),
      );
      setConfirmando(false);
      setMotivo('');
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos suprimir los datos.');
    } finally {
      setOcupado(null);
    }
  };

  return (
    <section className="mt-6 rounded-campo border border-line bg-rest p-4">
      <p className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 text-muted" />
        <span className="rotulo">Derechos de esta persona</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-muted">
        Si te pide sus datos o que los borres, es desde acá. Queda registrado quién lo hizo y
        cuándo.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secundario" size="chico" disabled={ocupado !== null} onClick={() => void exportar()}>
          {ocupado === 'exportar' ? 'Armando…' : 'Descargar sus datos'}
        </Button>
        {!confirmando && !resultado && (
          <Button
            variant="secundario"
            size="chico"
            disabled={ocupado !== null}
            onClick={() => setConfirmando(true)}
          >
            Suprimir sus datos
          </Button>
        )}
      </div>

      {confirmando && (
        <div className="mt-3 rounded-campo border border-bad-soft-br bg-bad-soft p-3">
          {/* El motivo no es burocracia: es la evidencia de que hubo una
              solicitud. El servidor lo exige y acá se dice por qué, para
              que nadie escriba "x" para pasar el campo. */}
          <p className="text-sm text-bad-text">
            Esto <strong>no se puede deshacer</strong>: se borran sus mensajes, sus identidades de
            canal y sus adjuntos. Se conservan las facturas y el libro de auditoría, porque la ley
            los exige.
          </p>
          <label className="mt-2 flex flex-col gap-1 text-sm text-body">
            Motivo de la solicitud
            <Input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Lo pidió por WhatsApp el 22/09"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="destructivo"
              size="chico"
              disabled={ocupado !== null || !motivo.trim()}
              onClick={() => void suprimir()}
            >
              {ocupado === 'suprimir' ? 'Suprimiendo…' : 'Confirmar supresión'}
            </Button>
            <Button variant="secundario" size="chico" onClick={() => setConfirmando(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {resultado && (
        <div className="mt-3 rounded-campo border border-line bg-bg p-3 text-sm text-body">
          <p className="font-medium text-ink">Listo. Esto es lo que se borró:</p>
          <ul className="mt-1 list-disc pl-5">
            <li>{resultado.mensajesBorrados} mensajes</li>
            <li>{resultado.identidadesBorradas} identidades de canal</li>
            <li>{resultado.actividadesBorradas} actividades</li>
            <li>{resultado.adjuntosR2.length} adjuntos</li>
            {resultado.ejecucionesVaciadas > 0 && (
              <li>{resultado.ejecucionesVaciadas} registros del asistente, vaciados</li>
            )}
          </ul>
          {resultado.conservado.length > 0 && (
            // Una supresión que no dice qué dejó en pie no es evidencia de
            // nada: es lo primero que va a preguntar quien reclame.
            <>
              <p className="mt-2 font-medium text-ink">Y esto se conservó, con su motivo:</p>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {resultado.conservado.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}
    </section>
  );
}
