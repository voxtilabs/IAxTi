'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

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
interface Franja {
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
  const [tenant, setTenant] = useState<string | null>(null);
  const [franjas, setFranjas] = useState<Franja[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [form, setForm] = useState({ weekday: 1, inicio: '09:00', fin: '18:00', duracion: 30, respiro: 0 });

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setFranjas(await apiFetch<Franja[]>(config, session, tenant, '/agenda/disponibilidad'));
    } catch (err) {
      setAviso((err as Error).message);
      setFranjas([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

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
      await cargar();
    } catch (err) {
      // Dos franjas que se pisan el mismo día duplican los huecos: el
      // servidor lo rechaza y lo explica.
      setAviso((err as Error).message);
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
      await cargar();
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  if (!tenant || franjas === null) return null;

  return (
    <section className="mt-8 rounded-campo border border-line bg-rest p-4">
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
