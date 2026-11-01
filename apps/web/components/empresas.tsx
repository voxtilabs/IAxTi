'use client';

import { AvisoResultado, Checkbox, EncabezadoDePagina, Formulario } from '@iaxti/ui/react';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, EstadoVacio, Input, Skeleton, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, type EmpresaDto } from '../lib/api';

// Empresas (#36, SPEC §10): el CRM cuando quien te compra no es una persona
// sino una oficina, y varios contactos pertenecen a la misma.
//
// La API estaba completa y no había pantalla. Peor: vivía en /v1/v1/empresas
// por un prefijo repetido (#340), así que la ruta documentada devolvía 404.
// Eso ya está arreglado; esto es la pantalla.

interface Contacto {
  id: string;
  name: string | null;
  phone: string;
}

export function Empresas() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [items, setItems] = useState<EmpresaDto[] | null>(null);
  const [buscar, setBuscar] = useState('');
  const [verArchivadas, setVerArchivadas] = useState(false);
  const [abierta, setAbierta] = useState<{ empresa: EmpresaDto; contactos: Contacto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', rut: '' });
  const [guardando, setGuardando] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [edicion, setEdicion] = useState({ name: '', rut: '' });

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const q = new URLSearchParams();
      if (buscar.trim()) q.set('buscar', buscar.trim());
      if (verArchivadas) q.set('archivadas', 'true');
      setItems(
        await apiFetch<EmpresaDto[]>(config, session, tenant, `/empresas${q.size ? `?${q}` : ''}`),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, [config, session, tenant, buscar, verArchivadas]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function crear(e: FormEvent) {
    e.preventDefault();
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      await apiFetch(config, session, tenant, '/empresas', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, ...(form.rut.trim() ? { rut: form.rut.trim() } : {}) }),
      });
      setForm({ name: '', rut: '' });
      setError(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  }

  async function ver(e: EmpresaDto) {
    if (!session || !tenant) return;
    if (abierta?.empresa.id === e.id) {
      setAbierta(null);
      return;
    }
    try {
      const d = await apiFetch<{ empresa: EmpresaDto; contactos: Contacto[] }>(
        config, session, tenant, `/empresas/${e.id}`,
      );
      setAbierta(d);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Guarda los datos corregidos. El RUT vacío viaja como `null` y eso lo
   * BORRA; el servidor lo valida y lo normaliza, y si está malo lo dice.
   */
  async function guardarEdicion(e: EmpresaDto) {
    if (!session || !tenant || ocupado) return;
    setOcupado(e.id);
    try {
      await apiFetch(config, session, tenant, `/empresas/${e.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: edicion.name.trim(), rut: edicion.rut.trim() || null }),
      });
      setError(null);
      setEditando(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  async function archivar(e: EmpresaDto) {
    if (!session || !tenant || ocupado) return;
    setOcupado(e.id);
    try {
      await apiFetch(config, session, tenant, `/empresas/${e.id}`, { method: 'DELETE' });
      setError(null);
      if (abierta?.empresa.id === e.id) setAbierta(null);
      await cargar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOcupado(null);
    }
  }

  const campoEmpresa = useRef<HTMLInputElement>(null);

  if (items === null) {
    return <div className="flex flex-col gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /></div>;
  }

  return (
    <section className="flex flex-col gap-6">
      <EncabezadoDePagina
        rotulo="EMPRESAS"
        titulo="Empresas"
        apoyo="Cada contacto puede colgar de una empresa desde su ficha."
      />

      {error && (
        <AvisoResultado tono="error">
          {error}
        </AvisoResultado>
      )}

      <Formulario onSubmit={crear} className="flex flex-wrap items-end gap-3 pulso-panel rounded-tarjeta border border-line bg-raised p-5">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm font-medium text-ink">
          Nombre de la empresa
          <Input
            ref={campoEmpresa}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Constructora del Sur SpA"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          RUT (opcional)
          <Input
            value={form.rut}
            onChange={(e) => setForm({ ...form, rut: e.target.value })}
            placeholder="76.086.428-5"
            className="dato"
          />
        </label>
        <Button type="submit" disabled={guardando}>
          {guardando ? 'Creando…' : 'Crear empresa'}
        </Button>
      </Formulario>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={buscar}
          onChange={(e) => setBuscar(e.target.value)}
          placeholder="Buscar por nombre o RUT"
          className="max-w-xs"
          aria-label="Buscar empresa"
        />
        <label className="flex items-center gap-2 text-sm text-body">
          <Checkbox
            checked={verArchivadas}
            onCheckedChange={(marcado) => setVerArchivadas(marcado === true)}
          />
          Ver también las archivadas
        </label>
      </div>

      {items.length === 0 ? (
        /**
         * Dos vacíos distintos, y la ACCIÓN es lo que los distingue (#588).
         *
         * El panel que había ya decía bien cuál era cuál —«ninguna con eso» vs
         * «todavía no hay»— pero los dos terminaban en nada. Y son dos
         * callejones diferentes: del primero se sale borrando la búsqueda, del
         * segundo creando la primera empresa. Un estado vacío que no ofrece la
         * salida correcta obliga a adivinar cuál de las dos cosas pasó.
         */
        buscar ? (
          <EstadoVacio
            titulo="Ninguna empresa con eso"
            descripcion="Puede ser que esté escrita distinto. Prueba con parte del nombre o con el RUT."
            accion={{ etiqueta: 'Borrar la búsqueda', onClick: () => setBuscar('') }}
          />
        ) : (
          <EstadoVacio
            titulo="Todavía no hay empresas"
            descripcion="Acá vas a ver las empresas de tus contactos."
            accion={{ etiqueta: 'Crear la primera', onClick: () => campoEmpresa.current?.focus() }}
            pideleAIAxTi="¿Para qué me sirve agrupar mis contactos por empresa?"
          />
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((e) => (
            <li key={e.id} className="pulso-panel rounded-tarjeta border border-line bg-raised">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <button
                  type="button"
                  onClick={() => void ver(e)}
                  aria-expanded={abierta?.empresa.id === e.id}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-ink">{e.name}</span>
                  {e.rut && <span className="dato block truncate text-xs text-muted">{e.rut}</span>}
                </button>
                {e.archivedAt && <Badge role="neutral">Archivada</Badge>}
                {!e.archivedAt && (
                  <>
                    {/* Editar una empresa (#480). `PUT /empresas/:id`
                        existe desde #217 y no la llamaba nadie: un nombre
                        mal escrito o un RUT que faltaba solo se arreglaban
                        archivándola y creando otra — y con ella se iban
                        los contactos colgados. */}
                    <Button
                      variant="fantasma"
                      size="chico"
                      onClick={() => {
                        setEditando(e.id);
                        setEdicion({ name: e.name, rut: e.rut ?? '' });
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="fantasma"
                      size="chico"
                      disabled={ocupado === e.id}
                      onClick={() => void archivar(e)}
                    >
                      Archivar
                    </Button>
                  </>
                )}
              </div>

              {editando === e.id && (
                <Formulario
                  className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void guardarEdicion(e);
                  }}
                >
                  <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-sm text-body">
                    Nombre
                    <Input
                      required
                      value={edicion.name}
                      onChange={(ev) => setEdicion({ ...edicion, name: ev.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-body">
                    RUT
                    <Input
                      className="dato"
                      value={edicion.rut}
                      onChange={(ev) => setEdicion({ ...edicion, rut: ev.target.value })}
                    />
                  </label>
                  <Button type="submit" disabled={ocupado === e.id}>
                    {ocupado === e.id ? 'Guardando…' : 'Guardar'}
                  </Button>
                  <Button type="button" variant="secundario" onClick={() => setEditando(null)}>
                    Dejar como estaba
                  </Button>
                </Formulario>
              )}

              {abierta?.empresa.id === e.id && (
                <div className="border-t border-line px-4 py-3">
                  <p className="rotulo">Contactos de esta empresa</p>
                  {abierta.contactos.length === 0 ? (
                    <p className="mt-2 text-sm text-muted">
                      Ninguno todavía. Se cuelgan desde la ficha de cada contacto.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1">
                      {abierta.contactos.map((c) => (
                        <li key={c.id}>
                          <a href={`/contactos/${c.id}`} className="text-sm text-action-text">
                            {c.name ?? <span className="dato">{c.phone}</span>}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
