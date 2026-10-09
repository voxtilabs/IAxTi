'use client';

import { useState } from 'react';
import { Skeleton, useSession } from '@iaxti/ui/react';
import { apiFetch, type ReasignacionDto } from '../../lib/api';
import { nombreDeQuien } from '../quien-lo-hizo';
import { useSelectedTenant } from '../tenant-switcher';

/**
 * A quién se le quitó la conversación (#697).
 *
 * `.claude/rules/negocio.md` pide «un dueño por conversación; **reasignar deja
 * rastro**». El rastro se escribía en `assignments` desde el primer día y
 * ninguna consulta lo leía: la regla estaba escrita, la escritura hecha, y lo
 * escrito no se podía ver desde el producto.
 *
 * «Esta conversación era mía y ya no» es del día a día de un equipo chico, y
 * hasta acá se contestaba con Auditoría —que pide permiso de auditoría— o con
 * nada.
 *
 * Se pide al abrir: la mayoría de las conversaciones no se reasignan nunca, y
 * traer el historial de todas para que se mire una es pagar por nada.
 */
export function Reasignaciones({ conversationId }: { conversationId: string }) {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [pasos, setPasos] = useState<ReasignacionDto[] | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function cargar(abierto: boolean) {
    if (!abierto || pasos || !session || !tenant) return;
    try {
      setPasos(
        await apiFetch<ReasignacionDto[]>(config, session, tenant, `/conversations/${conversationId}/asignaciones`),
      );
    } catch (e: unknown) {
      setAviso(e instanceof Error ? e.message : 'No pudimos cargar quién tuvo esta conversación.');
    }
  }

  /** «La tomó Carla» en la primera asignación; «de Carla a Diego» después. */
  function frase(p: ReasignacionDto): string {
    const de = nombreDeQuien(p.de);
    const a = nombreDeQuien(p.a);
    if (!de && a) return `La tomó ${a}`;
    if (de && !a) return `Quedó sin dueño (la tenía ${de})`;
    if (de && a) return `De ${de} a ${a}`;
    return 'Cambió de dueño';
  }

  return <details className="mt-6" onToggle={(e) => void cargar((e.currentTarget as HTMLDetailsElement).open)}>
    <summary className="w-fit cursor-pointer text-xs text-action-text">Quién la ha tenido</summary>
    {aviso && <p className="mt-2 text-xs text-warn-text">{aviso}</p>}
    {!pasos && !aviso && <Skeleton className="mt-2 h-10 w-full" />}
    {pasos && pasos.length === 0 && (
      <p className="mt-2 text-xs text-muted">Nunca cambió de dueño.</p>
    )}
    {pasos && pasos.length > 0 && <ol className="mt-2 flex flex-col gap-1">
      {pasos.map((p, i) => <li key={`${p.cuando}-${i}`} className="text-xs text-body">
        <span className="dato text-muted">{new Date(p.cuando).toLocaleString('es-CL')}</span>
        {' · '}{frase(p)}
        {/* `automation` es el motor de reglas (#62): que una regla la haya
            movido explica por qué nadie se acuerda de haberlo hecho. */}
        {p.actor === 'automation' && <span className="text-muted"> (una automatización)</span>}
        {p.motivo && <span className="text-muted"> · {p.motivo}</span>}
      </li>)}
    </ol>}
  </details>;
}
