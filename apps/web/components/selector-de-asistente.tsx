'use client';

import { useCallback, useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

/**
 * Elegir de qué asistente se está hablando (#494, ADR-0025).
 *
 * Un negocio puede tener VARIOS —vender, responder sobre los números,
 * confirmar horas— y desde que el Agente General los crea a medida, tener
 * varios pasa a ser lo normal. Tres pantallas tomaban `agentes[0]`: el modo
 * autónomo, las evaluaciones y el logro del objetivo. O sea que quien tenía
 * dos configuraba siempre el primero creyendo que configuraba el que estaba
 * mirando — y el modo autónomo es justo el ajuste donde equivocarse se nota
 * en la cara de un cliente.
 *
 * Vive en un solo lugar porque las tres hacen lo mismo: pedir la lista,
 * quedarse con uno, y rehacer el trabajo cuando cambia. Tres copias de eso
 * se desincronizan a la primera.
 */
export interface AsistenteBase {
  id: string;
  name: string;
  objetivo?: string | null;
}

export function useAsistenteElegido<T extends AsistenteBase>() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [asistentes, setAsistentes] = useState<T[] | null>(null);
  const [elegidoId, setElegidoId] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const lista = await apiFetch<T[]>(config, session, tenant, '/agents');
      setAsistentes(lista);
      // Se respeta lo elegido si sigue existiendo: recargar después de
      // guardar no puede devolverte al primero de la lista.
      setElegidoId((actual) => (actual && lista.some((a) => a.id === actual) ? actual : (lista[0]?.id ?? null)));
    } catch {
      // Sin permiso para ver los asistentes, la sección no aparece.
      setAsistentes([]);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  const elegido = asistentes?.find((a) => a.id === elegidoId) ?? null;
  return { tenant, asistentes, elegido, elegir: setElegidoId, recargar: cargar, reemplazar: (a: T) => {
    setAsistentes((antes) => (antes ?? []).map((x) => (x.id === a.id ? a : x)));
  } };
}

/**
 * El selector. Con UN solo asistente no se dibuja: un desplegable de una
 * opción es ruido, y ocupa el lugar donde debería estar el nombre.
 */
export function SelectorDeAsistente({
  asistentes,
  elegidoId,
  onElegir,
}: {
  asistentes: AsistenteBase[];
  elegidoId: string | null;
  onElegir: (id: string) => void;
}) {
  if (asistentes.length < 2) return null;
  return (
    <Select value={elegidoId ?? ''} onValueChange={onElegir}>
      <SelectTrigger aria-label="De qué asistente" className="h-9 w-56 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {asistentes.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
