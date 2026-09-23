'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { AvisoResultado, Button, Input, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

/**
 * Dar una hora desde la agenda (#460).
 *
 * `GET /agenda/huecos` y `POST /agenda` existen desde #57 y las usaba solo
 * el asistente, por sus herramientas. Quien atiende por teléfono —o quien
 * necesita agendar por alguien que no escribió por WhatsApp— no tenía
 * dónde: la agenda mostraba las horas dadas y ninguna forma de dar una.
 *
 * Los huecos salen del servidor, no de una grilla dibujada acá: ya
 * descuentan lo agendado, el respiro entre citas y la anticipación mínima.
 * Una grilla propia ofrecería horas que la API va a rechazar.
 */
interface Hueco {
  inicio: string;
  fin: string;
  hora: string;
}

interface ContactoLigero {
  id: string;
  name: string | null;
  phone: string | null;
}

function hoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DarUnaHora({ onAgendada }: { onAgendada: () => void }) {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [dia, setDia] = useState(hoy());
  const [huecos, setHuecos] = useState<Hueco[] | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [contactos, setContactos] = useState<ContactoLigero[]>([]);
  const [elegido, setElegido] = useState<ContactoLigero | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [agendando, setAgendando] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargarHuecos = useCallback(async () => {
    if (!session || !tenant || !abierto) return;
    setHuecos(null);
    try {
      setHuecos(await apiFetch<Hueco[]>(config, session, tenant, `/agenda/huecos?dia=${dia}`));
      setAviso(null);
    } catch (err) {
      setAviso((err as Error).message);
      setHuecos([]);
    }
  }, [config, session, tenant, dia, abierto]);
  useEffect(() => void cargarHuecos(), [cargarHuecos]);

  async function buscar() {
    if (!session || !tenant || !busqueda.trim()) return;
    try {
      const r = await apiFetch<{ items: ContactoLigero[] }>(
        config,
        session,
        tenant,
        `/contacts?q=${encodeURIComponent(busqueda.trim())}&limit=5`,
      );
      setContactos(r.items);
      setAviso(r.items.length === 0 ? 'No encontramos a nadie con eso.' : null);
    } catch (err) {
      setAviso((err as Error).message);
    }
  }

  async function agendar(h: Hueco) {
    if (!session || !tenant || !elegido || agendando) return;
    setAgendando(h.inicio);
    try {
      await apiFetch(config, session, tenant, '/agenda', {
        method: 'POST',
        body: JSON.stringify({ contactId: elegido.id, inicio: h.inicio, fin: h.fin }),
      });
      setAviso(null);
      setElegido(null);
      setContactos([]);
      setBusqueda('');
      await cargarHuecos();
      onAgendada();
    } catch (err) {
      // La hora se puede haber tomado entre que se cargó y el clic: el
      // servidor lo rechaza y por eso los huecos se vuelven a pedir.
      setAviso((err as Error).message);
      await cargarHuecos();
    } finally {
      setAgendando(null);
    }
  }

  if (!tenant) return null;

  if (!abierto) {
    return (
      <span>
        <Button variant="secundario" onClick={() => setAbierto(true)}>
          <CalendarPlus aria-hidden className="size-4" /> Dar una hora
        </Button>
      </span>
    );
  }

  return (
    <section className="rounded-tarjeta border border-line bg-raised p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink">Dar una hora</h2>
        <Button variant="fantasma" size="chico" onClick={() => setAbierto(false)}>Cerrar</Button>
      </div>

      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Día
          <Input type="date" className="dato w-44" value={dia} onChange={(e) => setDia(e.target.value)} />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-ink">
          ¿Para quién?
          <span className="flex gap-2">
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void buscar();
                }
              }}
              placeholder="Nombre o teléfono"
            />
            <Button type="button" variant="secundario" onClick={() => void buscar()}>Buscar</Button>
          </span>
        </label>
      </div>

      {contactos.length > 0 && !elegido && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {contactos.map((c) => (
            <li key={c.id}>
              <Button variant="fantasma" size="chico" onClick={() => setElegido(c)}>
                {c.name ?? 'Sin nombre'} <span className="dato ml-2 text-muted">{c.phone}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {elegido && (
        <p className="mt-2 text-sm text-body">
          Para <span className="font-medium text-ink">{elegido.name ?? elegido.phone}</span>{' '}
          <Button variant="fantasma" size="chico" onClick={() => setElegido(null)}>cambiar</Button>
        </p>
      )}

      <div className="mt-4">
        {huecos === null ? (
          <p className="text-sm text-muted">Buscando horas libres…</p>
        ) : huecos.length === 0 ? (
          // Sin horarios definidos no hay huecos, y es la causa más común:
          // decirlo acá evita buscar el problema en la agenda.
          <p className="text-sm text-muted">
            Ese día no tiene horas libres. Revisa los horarios en que atiendes, más abajo.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {huecos.map((h) => (
              <li key={h.inicio}>
                <Button
                  variant={elegido ? 'secundario' : 'fantasma'}
                  size="chico"
                  disabled={!elegido || agendando === h.inicio}
                  onClick={() => void agendar(h)}
                >
                  {agendando === h.inicio ? '…' : h.hora}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {!elegido && huecos && huecos.length > 0 && (
          <p className="mt-2 text-xs text-muted">Elige primero a quién le das la hora.</p>
        )}
      </div>
    </section>
  );
}
