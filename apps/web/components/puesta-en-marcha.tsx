'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Skeleton, useSession, type BadgeRole } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// La puesta en marcha (#56, SPEC §7).
//
// El estado ya se calculaba entero —cada paso lo responde su módulo, con lo
// que hay HOY y no solo con lo que la columna recuerda— y moría en un JSON
// que no consumía nadie. La portada mostraba un estado vacío fijo que decía
// lo mismo sin importar cómo iba el negocio.
//
// Lo que más importa mostrar es `desfase`: la columna no retrocede por
// diseño, así que un paso marcado de más se queda marcado para siempre. El
// servidor ya detecta cuándo eso pasa; sin pantalla, el negocio cree que
// tiene WhatsApp conectado porque alguna vez lo estuvo.

interface PasoDto {
  id: string;
  titulo: string;
  ayuda: string;
  opcional: boolean;
  hecho: boolean;
  detalle: string | null;
  bloqueado: boolean;
  fuente: 'verificado' | 'historial';
  ruta: string | null;
}

interface OnboardingDto {
  estadoRegistrado: string;
  pasos: PasoDto[];
  siguiente: string | null;
  completo: boolean;
  desfase: string[];
}

function etiquetaDe(p: PasoDto): { texto: string; rol: BadgeRole } {
  if (p.bloqueado) return { texto: 'No aplica', rol: 'neutral' };
  if (p.hecho) return { texto: 'Listo', rol: 'good' };
  if (p.opcional) return { texto: 'Opcional', rol: 'info' };
  return { texto: 'Pendiente', rol: 'warn' };
}

/**
 * Lo que ve quien no puede mirar el estado del negocio.
 *
 * `GET /onboarding` pide `tenant.settings`, que un vendedor no tiene. Un
 * 403 en la portada sería recibirlo con un error por entrar a su propia
 * casa: para él la portada es la bandeja y punto.
 */
function Bienvenida() {
  return (
    <div className="rounded-tarjeta border border-line bg-raised p-8">
      <p className="rotulo">Bandeja</p>
      <h2 className="mt-2 text-xl font-bold text-ink">
        Aquí van a llegar las conversaciones de tu negocio
      </h2>
      <p className="mt-2 max-w-prose text-body">
        Cuando conectes WhatsApp o actives el chat de tu sitio, cada mensaje aparecerá en la bandeja
        con su contacto y su historia.
      </p>
      <Link href="/bandeja" className="mt-6 inline-block">
        <Button variant="primario">Ir a la bandeja</Button>
      </Link>
    </div>
  );
}

export function PuestaEnMarcha() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [estado, setEstado] = useState<OnboardingDto | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setEstado(await apiFetch<OnboardingDto>(config, session, tenant, '/onboarding'));
    } catch {
      // Cualquier fallo acá cae a la bienvenida. La portada tiene que abrir
      // siempre: es lo primero que ve alguien que recién entra.
      setSinPermiso(true);
    }
  }, [config, session, tenant]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (sinPermiso) return <Bienvenida />;
  if (estado === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const siguiente = estado.pasos.find((p) => p.id === estado.siguiente) ?? null;
  const faltan = estado.pasos.filter((p) => !p.hecho && !p.bloqueado && !p.opcional).length;

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="font-display text-titulo text-ink">
          {estado.completo ? 'Tu negocio está en marcha' : 'Pon tu negocio en marcha'}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-body">
          {estado.completo
            ? 'Ya está todo lo necesario. Desde acá se atiende: las conversaciones llegan a la bandeja.'
            : faltan === 1
              ? 'Te falta un paso para empezar a atender.'
              : `Te faltan ${faltan} pasos para empezar a atender.`}
        </p>
      </header>

      {estado.desfase.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-campo border border-warn-soft-br bg-warn-soft px-4 py-3 text-sm text-warn-text"
        >
          <span className="font-medium">Esto figura hecho y hoy no está</span>
          <ul className="flex flex-col gap-1">
            {estado.desfase.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {estado.pasos.map((p) => {
          const etiqueta = etiquetaDe(p);
          const esSiguiente = p.id === estado.siguiente;
          return (
            <li
              key={p.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-tarjeta border border-line bg-raised p-4"
            >
              <div className="flex flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{p.titulo}</span>
                  <Badge role={etiqueta.rol}>{etiqueta.texto}</Badge>
                </span>
                <span className="max-w-prose text-sm text-body">
                  {p.bloqueado
                    ? 'Este paso no aplica a tu plan: el módulo que lo resuelve está apagado.'
                    : p.ayuda}
                </span>
                {p.detalle && <span className="text-xs text-muted">{p.detalle}</span>}
                {p.hecho && p.fuente === 'historial' && (
                  // No es lo mismo "lo comprobamos" que "quedó anotado".
                  <span className="text-xs text-muted">Quedó anotado; no lo comprobamos ahora.</span>
                )}
              </div>
              {p.ruta && !p.hecho && !p.bloqueado && (
                <Link href={p.ruta}>
                  <Button variant={esSiguiente ? 'primario' : 'fantasma'} size="chico">
                    {esSiguiente ? 'Hacerlo ahora' : 'Ir'}
                  </Button>
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      {estado.completo && (
        <div className="rounded-tarjeta border border-line bg-raised p-5">
          <p className="text-sm text-body">
            Lo que sigue ya no es puesta en marcha: es atender. Los mensajes de tus clientes llegan a
            la bandeja.
          </p>
          <Link href="/bandeja" className="mt-4 inline-block">
            <Button variant="primario">Ir a la bandeja</Button>
          </Link>
        </div>
      )}

      {!estado.completo && siguiente?.ruta && (
        <p className="text-xs text-muted">
          Lo siguiente: {siguiente.titulo.toLowerCase()}.
        </p>
      )}
    </section>
  );
}
