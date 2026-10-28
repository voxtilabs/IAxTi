'use client';

import { useEffect, useRef, useState } from 'react';
import { AvisoResultado, Button, CanalChip, EstadoVacio, Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, avisoDe, type Aviso } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';
import { useCarga } from './use-carga';
import { AvisoDeCarga } from './aviso-de-carga';

interface Opcion { senderId: string; kind: 'instagram' | 'messenger'; name: string }
interface Cuenta { id: string; kind: string; name: string; state: 'active' }

export function ConectarCanalesMeta({ onConectado }: { onConectado: (cuenta: Cuenta) => void }) {
  const { session } = useSession();
  const tenant = useSelectedTenant();
  if (!session || !tenant) return null;
  // El montaje pertenece a una sesión/tenant. Una respuesta tardía nunca
  // sustituye las opciones ni muestra el resultado en el negocio siguiente.
  return <Conexiones key={`${tenant}:${session.access_token}`} onConectado={onConectado} />;
}

function Conexiones({ onConectado }: { onConectado: (cuenta: Cuenta) => void }) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const { carga, reintentar, reemplazar } = useCarga<Opcion[]>('/channels/conexiones-disponibles');
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const viva = useRef(true);
  const ocupada = useRef(false);
  useEffect(() => { viva.current = true; return () => { viva.current = false; }; }, []);

  async function conectar(opcion: Opcion) {
    if (!session || !tenant || ocupada.current || carga.estado !== 'ok') return;
    ocupada.current = true;
    setEnCurso(`${opcion.senderId}:${opcion.kind}`);
    setAviso(null);
    try {
      const cuenta = await apiFetch<Cuenta>(config, session, tenant, '/channels/conectar', {
        method: 'POST', body: JSON.stringify({ senderId: opcion.senderId, kind: opcion.kind }),
      });
      if (!viva.current) return;
      reemplazar(carga.dato.filter((o) => o.senderId !== opcion.senderId || o.kind !== opcion.kind));
      onConectado(cuenta);
    } catch (error) {
      if (viva.current) setAviso(avisoDe(error));
    } finally {
      ocupada.current = false;
      if (viva.current) setEnCurso(null);
    }
  }

  return <section className="mt-6 min-h-96 rounded-campo border border-line bg-raised p-4" aria-label="Conectar Instagram y Messenger" aria-busy={enCurso !== null || carga.estado === 'cargando'}>
    <h2 className="text-lg font-semibold text-ink">Instagram y Messenger</h2>
    {carga.estado === 'cargando' || carga.estado === 'nada-que-pedir' ? <div className="mt-4 space-y-3" role="status" aria-label="Buscando conexiones"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-20 w-full" /></div> : null}
    <AvisoDeCarga carga={carga} onReintentar={reintentar} sinPermiso="Necesitas permiso para administrar canales y activar estas conexiones." />
    {aviso && <AvisoResultado tono="error" persistente>{aviso.texto}{aviso.rastro && <span className="dato mt-1 block break-all">{aviso.rastro}</span>}</AvisoResultado>}
    {carga.estado === 'ok' && (carga.dato.length === 0 ? <EstadoVacio
      titulo="No hay conexiones pendientes"
      descripcion="Primero conecta tu cuenta en Zavu y pide a quien administra el servicio que la habilite para tu negocio. Después vuelve a comprobar."
      accion={{ etiqueta: 'Volver a comprobar', onClick: reintentar }}
    /> : <ul className="mt-4 space-y-3">{carga.dato.map((opcion) => <li key={`${opcion.senderId}:${opcion.kind}`} className="flex flex-col items-stretch gap-3 rounded-campo border border-line p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1"><CanalChip canal={opcion.kind} /><p className="mt-1 break-words text-sm text-body">{opcion.name}</p></div>
      <Button variant="secundario" disabled={enCurso !== null} onClick={() => void conectar(opcion)}>
        {enCurso === `${opcion.senderId}:${opcion.kind}` ? 'Comprobando…' : `Conectar ${opcion.kind === 'instagram' ? 'Instagram' : 'Messenger'}`}
      </Button>
    </li>)}</ul>)}
  </section>;
}
