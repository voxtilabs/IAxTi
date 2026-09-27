'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AvisoResultado,
  Badge,
  Button,
  Skeleton,
  useSession,
  type BadgeRole,
} from '@iaxti/ui/react';
import { ApiError, apiFetch } from '../lib/api';
import { selectedTenant } from './tenant-switcher';

/**
 * Por qué la IA no está trabajando (#614).
 *
 * El canal tiene su diagnóstico desde #434 y ha servido cada vez. La IA no
 * tenía nada: si falta una credencial el modelo lanza, el error sube como
 * «Algo falló de nuestro lado» y no hay forma de saber que el problema es una
 * variable de entorno ausente. Así se llega a «nunca pude probar nada» — no
 * porque no funcione, sino porque no se puede ver por qué no.
 *
 * Dos decisiones que lo separan del diagnóstico del canal:
 *
 * 1. **Carga al entrar, no a pedido.** El del canal se pide con un botón
 *    porque hay uno por cuenta y la pregunta es «¿por qué ESTA?». Acá hay uno
 *    solo y la pregunta la trae puesta quien llega. Si hay que apretar algo
 *    para enterarse, no se entera: es exactamente el modo en que este
 *    diagnóstico podría existir sin servirle a nadie. Cuesta una consulta a
 *    los ajustes y una mirada al ambiente; no le pregunta nada al proveedor.
 * 2. **Cuando todo está bien se dice en una línea.** Un panel abierto
 *    repitiendo «bien, bien, bien» en cada visita es ruido que enseña a no
 *    mirar. Con problema, el panel se abre solo y marca el paso que falla.
 *
 * Va arriba del consumo a propósito: un gráfico en cero es el síntoma, y la
 * causa se lee antes que el síntoma.
 */

interface PasoDto {
  id: string;
  titulo: string;
  estado: 'bien' | 'mal' | 'atencion' | 'desconocido';
  detalle: string;
  queHacer?: string;
}

interface DiagnosticoDto {
  problema: string | null;
  pasos: PasoDto[];
}

const TONO_DEL_PASO: Record<PasoDto['estado'], { rol: BadgeRole; texto: string }> = {
  bien: { rol: 'good', texto: 'Bien' },
  atencion: { rol: 'warn', texto: 'Atención' },
  mal: { rol: 'bad', texto: 'Falla' },
  desconocido: { rol: 'neutral', texto: 'Sin datos' },
};

export function PorQueLaIaNoTrabaja() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [datos, setDatos] = useState<DiagnosticoDto | null | undefined>();
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const mirar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const r = await apiFetch<DiagnosticoDto>(config, session, tenant, '/agents/diagnostico');
      setDatos(r);
      // Con problema se abre solo. Sin problema queda cerrado y en una línea.
      setAbierto(r.problema !== null);
      setError(null);
    } catch (e) {
      // Sin `tenant.read` —o con el módulo apagado para este negocio— esto es
      // un 403, y no es un error que mostrar: quien atiende no revisa el
      // ambiente y no tiene por qué ver un aviso rojo por entrar a su propia
      // pantalla. Es el mismo criterio de los ajustes de IA.
      //
      // Cualquier otra cosa SÍ se muestra. Un diagnóstico que se calla cuando
      // él mismo falla es la forma más cruel de este defecto: la pantalla que
      // vino a explicar por qué algo no anda, sin explicar por qué no anda
      // ella. Por eso el 403 se distingue por su `status` y no hay un `catch`
      // que se lo coma todo.
      if (e instanceof ApiError && e.status === 403) {
        setDatos(null);
        return;
      }
      setDatos({ problema: null, pasos: [] });
      setError(
        e instanceof Error ? e.message : 'No pudimos revisar el estado de la IA. Intenta de nuevo.',
      );
    }
  }, [config, session, tenant]);

  useEffect(() => void mirar(), [mirar]);

  if (datos === null) return null;
  if (datos === undefined) return <Skeleton className="mt-6 h-16" />;

  // Sin pasos no se sabe nada, y «Lista» sería una afirmación inventada: es lo
  // que queda cuando el propio diagnóstico falló.
  const sinRespuesta = datos.pasos.length === 0;
  const hayProblema = datos.problema !== null;
  const conAtencion = datos.pasos.some((p) => p.estado === 'atencion');

  return (
    <section
      aria-label="Por qué la IA no está trabajando"
      className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="rotulo">Estado de la IA</span>
        <Badge
          role={sinRespuesta ? 'neutral' : hayProblema ? 'bad' : conAtencion ? 'warn' : 'good'}
        >
          {sinRespuesta
            ? 'Sin datos'
            : hayProblema
              ? 'No puede trabajar'
              : conAtencion
                ? 'Trabaja a medias'
                : 'Lista'}
        </Badge>
        {!sinRespuesta && (
          <Button variant="secundario" size="chico" onClick={() => setAbierto(!abierto)}>
            {abierto ? 'Ocultar el detalle' : 'Ver el detalle'}
          </Button>
        )}
        <Button variant="secundario" size="chico" onClick={() => void mirar()}>
          Revisar de nuevo
        </Button>
      </div>

      <p className="mt-2 max-w-prose text-sm text-body">
        {sinRespuesta
          ? 'No alcanzamos a revisarlo. Abajo está qué pasó al intentarlo.'
          : hayProblema
            ? 'Hay algo que impide que la IA haga su trabajo, y acá se ve cuál. Ninguna ' +
              'credencial se muestra: solo si está configurada o no, así que esta pantalla se ' +
              'puede compartir para pedir ayuda.'
            : conAtencion
              ? 'La IA puede trabajar, pero no en todo. En el detalle está qué tarea queda afuera.'
              : 'Todo lo que la IA necesita está configurado en este ambiente.'}
      </p>

      {abierto && (
        <ul className="mt-4 flex flex-col gap-2">
          {datos.pasos.map((paso) => {
            const tono = TONO_DEL_PASO[paso.estado];
            return (
              <li key={paso.id} className="rounded-campo border border-line bg-bg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge role={tono.rol}>{tono.texto}</Badge>
                  <span className="text-sm font-medium text-ink">{paso.titulo}</span>
                  {datos.problema === paso.id && (
                    <span className="text-xs text-warn-text">— es esto</span>
                  )}
                </div>
                <p className="mt-1 text-sm text-body">{paso.detalle}</p>
                {paso.queHacer && (
                  <p className="mt-1 text-sm text-muted">
                    <strong className="font-medium text-body">Qué hacer:</strong> {paso.queHacer}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && <AvisoResultado tono="error">{error}</AvisoResultado>}
    </section>
  );
}
