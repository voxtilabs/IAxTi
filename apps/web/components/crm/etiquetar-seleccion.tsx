'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, useSession } from '@iaxti/ui/react';
import { crmClient } from '@iaxti/sdk';

export function EtiquetarSeleccion({ tenant, contactIds, onDone }: { tenant: string; contactIds: string[]; onDone: () => void }) {
  const { session, config } = useSession();
  const client = useMemo(() => session ? crmClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (client) void client.tags().then(setTags).catch((e: Error) => setNotice(e.message)); }, [client]);
  async function agregar() {
    if (!client || !tag || !contactIds.length || lock.current) return;
    lock.current = true; setBusy(true); setNotice(null);
    try {
      const result = await client.tag([...new Set(contactIds)], tag);
      setNotice(`Etiqueta agregada a ${result.changed} contactos; ${result.requested - result.changed} ya la tenían.`);
      onDone();
    } catch (e) { setNotice((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="space-y-2">
    {!!contactIds.length && <div className="flex flex-wrap items-center gap-3 rounded-campo border border-line p-3">
      <label className="min-w-0 text-dato">Agregar etiqueta a los contactos seleccionados
        <select value={tag} onChange={(e) => setTag(e.target.value)} disabled={busy} className="mt-1 block h-control w-full rounded-campo border border-line-strong bg-field px-3 text-ink">
          <option value="">Elige una etiqueta</option>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <Button variant="secundario" disabled={!tag || busy} onClick={() => void agregar()}>{busy ? 'Agregando…' : 'Agregar etiqueta'}</Button>
      <p className="text-dato text-muted">Se conservan las etiquetas actuales de cada contacto.</p>
    </div>}
    {notice && <p role="status" className="text-dato text-body">{notice}</p>}
  </div>;
}
