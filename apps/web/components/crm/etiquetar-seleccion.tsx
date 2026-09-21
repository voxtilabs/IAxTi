'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AvisoResultado, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useSession } from '@iaxti/ui/react';
import { crmClient } from '@iaxti/sdk';

export function EtiquetarSeleccion({ tenant, contactIds, onDone }: { tenant: string; contactIds: string[]; onDone: () => void }) {
  const { session, config } = useSession();
  const client = useMemo(() => session ? crmClient({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }) : null, [config.apiUrl, session, tenant]);
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tono, setTono] = useState<'success' | 'error'>('error');
  useEffect(() => { if (client) void client.tags().then(setTags).catch((e: Error) => setNotice(e.message)); }, [client]);
  async function agregar() {
    if (!client || !tag || !contactIds.length || lock.current) return;
    lock.current = true; setBusy(true); setNotice(null);
    try {
      const result = await client.tag([...new Set(contactIds)], tag);
      setTono('success');
      setNotice(`Etiqueta agregada a ${result.changed} contactos; ${result.requested - result.changed} ya la tenían.`);
      onDone();
    } catch (e) { setTono('error'); setNotice((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="space-y-2">
    {!!contactIds.length && <div className="flex flex-wrap items-center gap-3 rounded-campo border border-line p-3">
      <label className="min-w-0 text-dato">Agregar etiqueta a los contactos seleccionados
        <Select value={tag} onValueChange={setTag} disabled={busy}>
          <SelectTrigger className="mt-1 h-control w-full bg-field" aria-label="Agregar etiqueta"><SelectValue placeholder="Elige una etiqueta" /></SelectTrigger>
          <SelectContent>{tags.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <Button variant="secundario" disabled={!tag || busy} onClick={() => void agregar()}>{busy ? 'Agregando…' : 'Agregar etiqueta'}</Button>
      <p className="text-dato text-muted">Se conservan las etiquetas actuales de cada contacto.</p>
    </div>}
    {notice && <AvisoResultado tono={tono}>{notice}</AvisoResultado>}
  </div>;
}
