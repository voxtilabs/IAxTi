'use client';

import { useState, type FormEvent } from 'react';
import { CalendarClock } from 'lucide-react';
import {
  AvisoResultado,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useSession,
} from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe } from '../lib/api';
import { AvisoDeCarga } from './aviso-de-carga';
import { PanelCargando } from './panel-cargando';
import { useCarga } from './use-carga';

/**
 * Los horarios en que atiendo (#460).
 *
 * `POST /agenda/disponibilidad` existe desde #57 y no la llamaba nadie: la
 * agenda ofrecía huecos con lo que hubiera quedado sembrado, y el
 * asistente —que usa `calendar.get_slots`— ofrecía esas mismas horas.
 * Quien atiende sábados por la mañana no tenía cómo decirlo.
 *
 * La lectura y el borrado se agregaron con esta pantalla: sin verlos, cada
 * visita apilaba una franja más sobre las que ya estaban.
 */
// Exportado para que `esqueletos-medidos.spec.ts` TIPE su simulacro: si
// este DTO cambia, la prueba deja de compilar en vez de seguir midiendo
// contra una forma que ya no existe.
export interface Franja {
  id: string;
  weekday: number;
  inicio: string;
  fin: string;
  duracion: number;
  respiro: number;
  anticipacion: number;
}

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export function HorariosDeAtencion() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  /**
   * Los cinco estados por el camino compartido (#788).
   *
   * Lo que había acá era un apaño que FUNCIONABA y por un motivo escrito: el
   * `catch` de la carga hacía `setFranjas([])` para que la guarda de abajo
   * pasara y el aviso llegara a dibujarse. Era la única de las cinco que no se
   * tragaba el error de carga. El precio era que una caída se veía EXACTAMENTE
   * igual que un horario vacío: cero franjas, el formulario listo, y el aviso
   * al lado. Con los estados nombrados, «no hay franjas» y «no se pudieron
   * leer» dejan de ser el mismo dibujo.
   */
  const { carga, recargando, reintentar } = useCarga<Franja[]>('/agenda/disponibilidad');
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [form, setForm] = useState({ weekday: 1, inicio: '09:00', fin: '18:00', duracion: 30, respiro: 0 });

  const cargar = reintentar;

  async function agregar(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || ocupado) return;
    setOcupado('nueva');
    try {
      await apiFetch(config, session, tenant, '/agenda/disponibilidad', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setAviso(null);
      cargar();
    } catch (err) {
      // Dos franjas que se pisan el mismo día duplican los huecos: el
      // servidor lo rechaza y lo explica. Con `avisoDe` la explicación llega
      // con su `code · requestId` (#659, #788).
      setAviso(avisoDe(err).texto);
    } finally {
      setOcupado(null);
    }
  }

  async function quitar(f: Franja) {
    if (!session || !tenant || ocupado) return;
    setOcupado(f.id);
    try {
      await apiFetch(config, session, tenant, `/agenda/disponibilidad/${f.id}`, { method: 'DELETE' });
      setAviso(null);
      cargar();
    } catch (err) {
      setAviso(avisoDe(err).texto);
    } finally {
      setOcupado(null);
    }
  }

  const marco = 'mt-8 rounded-campo border border-line bg-rest p-4';
  const titulo = 'Horario de atención';

  if (carga.estado === 'nada-que-pedir') return null;
  // 798 px MEDIDOS, repartidos en cinco barras: el panel cargado con las
  // cinco franjas de lunes a viernes mide 864. A ojo le había puesto 196 —se
  // quedaba a 600 px del contenido—, y 600 px de salto no es un detalle: es la
  // mitad de la pantalla de un celular moviéndose de golpe.
  if (carga.estado === 'cargando') {
    // 840 y no 798 (#1106): los botones chicos pasaron de 36 a 44 px de alto
    // para llegar al mínimo táctil, y este panel tiene varios. El esqueleto
    // existe para que la página NO salte cuando llega el contenido, así que
    // su alto es una medición, no una preferencia — `esqueletos-medidos`
    // compara los dos y falla si se separan más de 16 px.
    return <PanelCargando etiqueta={titulo} className={marco} alto={840} filas={5} superficie="rest" />;
  }
  if (carga.estado !== 'ok') {
    // El 403 lleva frase acá, y es el único de los cinco paneles que la lleva:
    // el horario de atención es lo que decide cuándo la agenda ofrece horas,
    // así que una agenda que no muestra su horario y tampoco dice por qué deja
    // a alguien buscando una configuración que sí existe pero no es suya.
    return (
      <section aria-label={titulo} className={marco}>
        <h2 className="text-base font-bold text-ink">{titulo}</h2>
        <div className="mt-2">
          <AvisoDeCarga
            carga={carga}
            onReintentar={reintentar}
            sinPermiso="El horario de atención lo configura quien administra la agenda."
          />
        </div>
      </section>
    );
  }
  const franjas = carga.dato;

  return (
    <section aria-label={titulo} aria-busy={recargando} className={marco}>
      <p className="flex items-center gap-2">
        <CalendarClock aria-hidden className="size-4 text-muted" />
        <span className="rotulo">Horarios en que atiendes</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-body">
        De acá salen las horas que se ofrecen, en la bandeja y también cuando las ofrece el
        asistente. Sin un horario definido, la agenda ofrece lo que quedó por defecto.
      </p>

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      {franjas.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Todavía no defines ninguno.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {franjas.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-campo border border-line bg-bg px-3 py-2 text-sm">
              <span className="w-24 font-medium text-ink">{DIAS[f.weekday]}</span>
              <span className="dato text-body">{f.inicio} a {f.fin}</span>
              <span className="text-muted">
                citas de {f.duracion} min
                {f.respiro > 0 && `, ${f.respiro} de respiro`}
              </span>
              <Button
                variant="fantasma"
                size="chico"
                className="ml-auto"
                disabled={ocupado === f.id}
                onClick={() => void quitar(f)}
              >
                {ocupado === f.id ? 'Quitando…' : 'Quitar'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={agregar} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Día
          <Select
            value={String(form.weekday)}
            onValueChange={(valor) => setForm({ ...form, weekday: Number(valor) })}
          >
            <SelectTrigger className="h-control w-40 bg-field text-base">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIAS.map((d, i) => (
                <SelectItem key={d} value={String(i)}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Desde
          <Input
            type="time"
            className="dato w-32"
            value={form.inicio}
            onChange={(e) => setForm({ ...form, inicio: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Hasta
          <Input
            type="time"
            className="dato w-32"
            value={form.fin}
            onChange={(e) => setForm({ ...form, fin: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Cada cita dura
          <Input
            type="number"
            min={5}
            max={480}
            className="dato w-24"
            value={form.duracion}
            onChange={(e) => setForm({ ...form, duracion: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Respiro entre citas
          <Input
            type="number"
            min={0}
            max={240}
            className="dato w-24"
            value={form.respiro}
            onChange={(e) => setForm({ ...form, respiro: Number(e.target.value) })}
          />
        </label>
        <Button type="submit" disabled={ocupado === 'nueva'}>
          {ocupado === 'nueva' ? 'Agregando…' : 'Agregar horario'}
        </Button>
        <span className="w-full text-xs text-muted">
          Quitar un horario no cancela las citas que ya estaban tomadas: siguen en la agenda.
        </span>
      </form>
    </section>
  );
}
