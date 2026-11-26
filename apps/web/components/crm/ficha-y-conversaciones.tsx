'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from '../tenant-switcher';
import { apiFetch, type ConversacionItem } from '../../lib/api';
import { FichaContacto } from './ficha-contacto';
import { HistoriaConversaciones } from './historia-conversaciones';

/**
 * La ficha y su historia, con las conversaciones pedidas UNA vez (#1395).
 *
 * El encabezado de la ficha necesita saber cuál es la conversación más
 * reciente —para «Abrir conversación»— y la historia las necesita todas. Si
 * cada uno pidiera `GET /conversations?contactId=` por su cuenta, abrir una
 * ficha costaría dos viajes para traer lo mismo; las conversaciones se piden
 * acá, una sola vez, y bajan a los dos.
 */
export function FichaYConversaciones({ contactId }: { contactId: string }) {
  const { session, config } = useSession();
  const tenant = useSelectedTenant();
  const [conversaciones, setConversaciones] = useState<ConversacionItem[] | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const res = await apiFetch<{ items: ConversacionItem[] }>(
        config, session, tenant, `/conversations?contactId=${contactId}`,
      );
      // La API las devuelve de la más reciente a la más vieja: la primera de
      // la lista es la que abre «Abrir conversación».
      setConversaciones(Array.isArray(res.items) ? res.items : []);
    } catch {
      // Sin conversaciones conocidas la ficha se dibuja igual: el botón
      // principal no aparece y la historia dice que no hay.
      setConversaciones([]);
    }
  }, [config, session, tenant, contactId]);
  useEffect(() => void cargar(), [cargar]);

  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
      <div className="flex-1"><FichaContacto contactId={contactId} conversaciones={conversaciones} /></div>
      <aside className="lg:w-96"><HistoriaConversaciones items={conversaciones} /></aside>
    </div>
  );
}
