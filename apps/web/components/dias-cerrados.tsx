'use client';

import { useState, type FormEvent } from 'react';
import { CalendarOff } from 'lucide-react';
import { AvisoResultado, Button, Checkbox, Formulario, Input, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';

/**
 * Los días que no abro (#1281).
 *
 * `availability` guarda el horario por día de la semana, así que un feriado no
 * tenía dónde ir: el 18 de septiembre de 2026 cae viernes, y una barbería que
 * atiende los viernes confirmaba horas para ese día. Con el asistente tomando
 * horas solo, el cliente llegaba a la puerta cerrada con una confirmación de
 * WhatsApp en la mano.
 *
 * La única salida era quitar el horario del viernes completo —perdiendo la
 * configuración— y volver a ponerlo el lunes.
 */
// Exportado para que las pruebas del panel TIPEN su simulacro: si este DTO
// cambia, la prueba deja de compilar en vez de medir una forma que ya no es.
export interface Cierre {
  id: string;
  ownerId: string | null;
  desde: string;
  hasta: string;
  motivo: string | null;
}

/** `2030-06-11` → `11 de junio`. El año solo si no es el que corre. */
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function comoFecha(dia: string, anioActual: number): string {
  const [a, m, d] = dia.split('-').map(Number);
  const mes = MESES[m - 1] ?? '';
  return a === anioActual ? `${d} de ${mes}` : `${d} de ${mes} de ${a}`;
}

/** `desde` y `hasta` iguales es un día, no un rango de un día. */
export function comoRango(cierre: Pick<Cierre, 'desde' | 'hasta'>, anioActual: number): string {
  const desde = comoFecha(cierre.desde, anioActual);
  return cierre.desde === cierre.hasta ? desde : `${desde} al ${comoFecha(cierre.hasta, anioActual)}`;
}

export function DiasCerrados() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  // Solo lo que viene, y el día de corte lo calcula el servidor con la zona
  // del negocio. Calcularlo acá con `toISOString()` da UTC, y en Chile a
  // partir de las 21:00 eso ya es mañana: un cierre de hoy desaparecía de la
  // lista justo la noche anterior al día que cierra.
  const { carga, recargando, reintentar } = useCarga<Cierre[]>('/agenda/cierres');
  // `warning` y no `success` para las citas que quedaron adentro: no es un
  // logro, es algo que alguien tiene que ir a resolver.
  const [aviso, setAviso] = useState<{ tono: 'error' | 'warning'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [form, setForm] = useState({ desde: '', hasta: '', motivo: '', todoElNegocio: false });

  async function cerrar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || ocupado) return;
    setOcupado('nuevo');
    try {
      const r = (await apiFetch(config, session, tenant, '/agenda/cierres', {
        method: 'POST',
        body: JSON.stringify({
          desde: form.desde,
          // Un día suelto se manda sin `hasta`: el servidor lo cierra solo.
          hasta: form.hasta || undefined,
          motivo: form.motivo || undefined,
          todoElNegocio: form.todoElNegocio || undefined,
        }),
      })) as { citasAfectadas?: { id: string }[] };
      const cuantas = r.citasAfectadas?.length ?? 0;
      // Cerrar NO cancela nada, y eso hay que decirlo donde se decide: si
      // quedaron citas adentro, alguien tiene que avisarle a esas personas.
      setAviso(
        cuantas === 0
          ? null
          : {
              tono: 'warning',
              texto:
                cuantas === 1
                  ? 'Queda 1 cita tomada en esos días. No se canceló: avísale tú y muévela o cancélala desde la agenda.'
                  : `Quedan ${cuantas} citas tomadas en esos días. No se cancelaron: avísales tú y muévelas o cancélalas desde la agenda.`,
            },
      );
      setForm({ desde: '', hasta: '', motivo: '', todoElNegocio: false });
      reintentar();
    } catch (err) {
      setAviso({ tono: 'error', texto: avisoDe(err).texto });
    } finally {
      setOcupado(null);
    }
  }

  async function reabrir(cierre: Cierre) {
    if (!session || !tenant || ocupado) return;
    setOcupado(cierre.id);
    try {
      await apiFetch(config, session, tenant, `/agenda/cierres/${cierre.id}`, { method: 'DELETE' });
      setAviso(null);
      reintentar();
    } catch (err) {
      setAviso({ tono: 'error', texto: avisoDe(err).texto });
    } finally {
      setOcupado(null);
    }
  }

  // El mismo marco que los otros bloques de /agenda (#1122).
  const marco = 'pulso-panel w-full max-w-seccion rounded-tarjeta border border-line bg-raised p-6';
  const titulo = 'Días que no abro';

  if (carga.estado === 'nada-que-pedir') return null;
  if (carga.estado === 'cargando') {
    /*
     * 691 MEDIDOS con `esqueletos-medidos`, y el número sale de DOS mediciones
     * que no coinciden:
     *
     *   acá  → contenido 759,8 px
     *   CI   → ~785,8 px  (el runner mide 26 px más, medido en esta misma rama)
     *
     * Los 26 px son el renderizado de fuentes del runner, que no tiene las
     * mismas instaladas: el mismo texto envuelve en más líneas. Los otros
     * cinco paneles también difieren, solo que menos que la tolerancia de
     * 16 px; este tiene más párrafo que puede envolver.
     *
     * El alto no persigue ninguna de las dos: queda a 13 px de las dos (el
     * marco aporta 82). Perseguir la medida local deja CI rojo, y perseguir
     * la de CI deja un salto visible acá.
     *
     * Y OJO si se toca el texto: este número DEPENDE de la prosa del panel.
     * Recortar dos líneas para bajar del techo de #1157 le quitó 40 px al
     * contenido y dejó el esqueleto 52 px largo. Cambiar un párrafo obliga a
     * volver a medir — a ojo le había puesto 332 la primera vez, casi 400 px
     * de salto, que en un celular es media pantalla moviéndose de golpe.
     */
    return <PanelCargando etiqueta={titulo} className={marco} alto={691} filas={2} superficie="raised" />;
  }
  if (carga.estado !== 'ok') {
    return (
      <section aria-label={titulo} className={marco}>
        <h2 className="text-base font-semibold text-ink">{titulo}</h2>
        <div className="mt-2">
          <AvisoDeCarga
            carga={carga}
            onReintentar={reintentar}
            sinPermiso="Los días cerrados los configura quien administra la agenda."
          />
        </div>
      </section>
    );
  }
  const cierres = carga.dato;
  const anio = new Date().getFullYear();

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <p className="flex items-center gap-2">
        <CalendarOff aria-hidden className="size-4 text-muted" />
        <span className="rotulo">Feriados y vacaciones</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-body">
        Un día cerrado no ofrece horas, ni el asistente.
      </p>

      {aviso && <AvisoResultado tono={aviso.tono}>{aviso.texto}</AvisoResultado>}

      {cierres.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No tienes ningún día cerrado.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {cierres.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-campo border border-line bg-bg px-3 py-2 text-sm"
            >
              <span className="dato font-medium text-ink">{comoRango(c, anio)}</span>
              {c.motivo && <span className="text-body">{c.motivo}</span>}
              {c.ownerId === null && <span className="text-muted">todo el negocio</span>}
              <Button
                variant="quitar"
                size="chico"
                className="ml-auto"
                disabled={ocupado === c.id}
                onClick={() => void reabrir(c)}
              >
                {ocupado === c.id ? 'Reabriendo…' : 'Reabrir'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* `Formulario` y no `<form>`: es lo que impide que salga la burbuja
          nativa de validación del navegador, que no se tematiza y habla en el
          idioma del sistema operativo (#618). */}
      <Formulario onSubmit={cerrar} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Día
          <Input
            type="date"
            required
            className="dato w-44"
            value={form.desde}
            onChange={(e) => setForm({ ...form, desde: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Hasta (si son varios)
          <Input
            type="date"
            min={form.desde || undefined}
            className="dato w-44"
            value={form.hasta}
            onChange={(e) => setForm({ ...form, hasta: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Motivo
          <Input
            className="w-56"
            placeholder="Vacaciones, 18 de septiembre"
            value={form.motivo}
            onChange={(e) => setForm({ ...form, motivo: e.target.value })}
          />
        </label>
        <label className="inline-flex min-h-control items-center gap-2 text-sm font-medium text-ink">
          <Checkbox
            checked={form.todoElNegocio}
            onCheckedChange={(marcado) => setForm({ ...form, todoElNegocio: marcado === true })}
          />
          Para todo el equipo
        </label>
        <Button type="submit" disabled={ocupado === 'nuevo' || !form.desde}>
          {ocupado === 'nuevo' ? 'Cerrando…' : 'Cerrar estos días'}
        </Button>
        <span className="w-full text-xs text-muted">
          Cerrar no cancela las citas ya tomadas: te decimos cuántas.
        </span>
      </Formulario>
    </section>
  );
}
