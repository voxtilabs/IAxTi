'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  AvisoResultado,
  Badge,
  Button,
  EstadoVacio,
  Textarea,
  useSession,
} from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// Preguntarle a los números (#410).
//
// Vive ACÁ y no en una pantalla aparte a propósito: la pregunta nace
// mirando el tablero ("¿y esto por qué bajó?"), y una respuesta a dos
// clics de distancia del número al que se refiere se puede contrastar de
// un vistazo. Un chat en otra sección sería otra cosa que revisar.
//
// El asistente NO calcula: pide la métrica y la lee. Por eso se muestra de
// dónde salió cada respuesta — sin esa línea, un número correcto y uno
// inventado se ven exactamente igual.

interface AgenteDto {
  id: string;
  name: string;
  objetivo: string | null;
  active?: boolean;
}

interface RespuestaDto {
  texto: string | null;
  herramientasUsadas: string[];
  truncada: boolean;
}

const EJEMPLOS = [
  '¿Cómo venimos este mes comparado con el anterior?',
  '¿Cuántas conversaciones quedaron sin responder?',
  '¿Cuánto sumamos en oportunidades ganadas en los últimos 30 días?',
];

const DE_DONDE: Record<string, string> = {
  'analytics.catalogo': 'la lista de métricas',
  'analytics.metrica': 'tus reportes',
  'analytics.comparar': 'tus reportes (dos periodos)',
};

export function PreguntaALosNumeros() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [agente, setAgente] = useState<AgenteDto | null>(null);
  const [cargado, setCargado] = useState(false);
  const [pregunta, setPregunta] = useState('');
  const [respuesta, setRespuesta] = useState<RespuestaDto | null>(null);
  const [pensando, setPensando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const agentes = await apiFetch<AgenteDto[]>(config, session, tenant, '/agents');
      setAgente(agentes.find((a) => a.objetivo === 'estadisticas' && a.active !== false) ?? null);
    } catch {
      /* sin permiso agents.use: la sección no aparece y el tablero sigue igual */
    } finally {
      setCargado(true);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant || !cargado) return null;

  if (!agente) {
    return (
      <EstadoVacio
        compacto
        titulo="Pregúntale a tus números"
        descripcion={
          'Puedes tener un asistente que lee estos mismos reportes y te los explica en palabras. ' +
          'No calcula nada por su cuenta: consulta la métrica y te dice de dónde la sacó.'
        }
        accion={{ etiqueta: 'Crear el asistente', href: '/ajustes/ia' }}
      />
    );
  }

  const preguntar = async (texto: string) => {
    if (!session || !texto.trim()) return;
    setAviso(null);
    setRespuesta(null);
    setPensando(true);
    try {
      const r = await apiFetch<RespuestaDto>(config, session, tenant, `/agents/${agente.id}/preguntar`, {
        method: 'POST',
        body: JSON.stringify({ pregunta: texto.trim() }),
      });
      setRespuesta(r);
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos preguntarle.');
    } finally {
      setPensando(false);
    }
  };

  return (
    <section
      aria-label="Pregúntale a tus números"
      className="pulso-panel rounded-tarjeta border border-line bg-raised p-4"
    >
      <div className="flex items-center gap-2">
        <Sparkles aria-hidden className="size-4 text-action-text" />
        <h3 className="font-display text-seccion font-bold text-ink">Pregúntale a tus números</h3>
        <Badge>{agente.name}</Badge>
      </div>
      <p className="mt-1 text-dato text-muted">
        Responde con lo que dicen estos reportes. Si un dato no existe, lo dice — no lo estima.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {EJEMPLOS.map((e) => (
          <button
            key={e}
            type="button"
            disabled={pensando}
            onClick={() => {
              setPregunta(e);
              campo.current?.focus();
              void preguntar(e);
            }}
            className="rounded-boton border border-line px-3 py-1 text-dato text-body transition-colors hover:bg-rest disabled:opacity-50"
          >
            {e}
          </button>
        ))}
      </div>

      <Textarea
        ref={campo}
        rows={2}
        className="mt-3"
        value={pregunta}
        disabled={pensando}
        placeholder="¿Qué quieres saber?"
        onChange={(ev) => setPregunta(ev.target.value)}
      />
      <div className="mt-2 flex justify-end">
        <Button onClick={() => void preguntar(pregunta)} disabled={pensando || !pregunta.trim()}>
          {pensando ? 'Consultando tus reportes…' : 'Preguntar'}
        </Button>
      </div>

      {aviso && <AvisoResultado tono="error" persistente>{aviso}</AvisoResultado>}

      {respuesta && (
        <div className="mt-3 rounded-tarjeta border border-line bg-rest p-4">
          <p className="whitespace-pre-wrap text-dato text-body">{respuesta.texto}</p>
          {respuesta.truncada && (
            <AvisoResultado tono="warning" persistente>
              La respuesta quedó cortada. Prueba con una pregunta más acotada.
            </AvisoResultado>
          )}
          <p className="mt-3 border-t border-line pt-2 text-rotulo text-muted">
            {respuesta.herramientasUsadas.length > 0 ? (
              <>Salió de {[...new Set(respuesta.herramientasUsadas.map((t) => DE_DONDE[t] ?? t))].join(' y ')}.</>
            ) : (
              // Sin herramientas no consultó nada: lo que dijo no está
              // respaldado por ningún número de este negocio, y decirlo es
              // más honesto que mostrar la respuesta sola.
              <>No consultó ningún reporte para responder esto. Confírmalo en el tablero de arriba.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
