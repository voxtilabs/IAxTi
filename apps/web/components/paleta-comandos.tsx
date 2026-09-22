'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AvisoResultado, Button, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  Dialog, DialogTrigger, DialogContent, DialogDescription, DialogTitle, useSession,
} from '@iaxti/ui/react';
import { apiFetch, ApiError, type BusquedaHit } from '../lib/api';
import { selectedTenant } from './tenant-switcher';

export function PaletaComandos({ nav }: { nav: Array<{ path: string; label: string }> }) {
  const { session, config } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [contacts, setContacts] = useState<Array<{ id: string; name: string | null; phone: string | null }>>([]);
  const [conversations, setConversations] = useState<BusquedaHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.isComposing && !event.altKey) {
        event.preventDefault(); setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!open) { setQ(''); setContacts([]); setConversations([]); setError(null); }
  }, [open]);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const tenant = selectedTenant();
    setContacts([]); setConversations([]); setError(null);
    if (!open || !session || !tenant || q.trim().length < 2) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      const query = encodeURIComponent(q.trim());
      const results = await Promise.allSettled([
        apiFetch<{ items: typeof contacts }>(config, session, tenant, `/contacts?q=${query}&limit=5`, { signal: controller.signal }),
        apiFetch<BusquedaHit[]>(config, session, tenant, `/search?q=${query}`, { signal: controller.signal }),
      ]);
      if (!current) return;
      if (results[0].status === 'fulfilled') setContacts(results[0].value.items);
      if (results[1].status === 'fulfilled') setConversations(results[1].value.filter((hit, i, all) => all.findIndex((h) => h.conversationId === hit.conversationId) === i).slice(0, 5));
      for (const result of results) if (result.status === 'rejected' && !(result.reason instanceof ApiError && result.reason.status === 403)) setError('No pudimos completar la búsqueda. Intenta nuevamente.');
      setLoading(false);
    }, 250);
    const changed = () => setOpen(false);
    window.addEventListener('storage', changed); window.addEventListener('iaxti-tenant-changed', changed);
    return () => { current = false; controller.abort(); clearTimeout(timer); window.removeEventListener('storage', changed); window.removeEventListener('iaxti-tenant-changed', changed); };
  }, [config, session, q, open]);

  const go = (path: string) => { setOpen(false); router.push(path); };
  const normal = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button variant="fantasma" aria-label="Buscar o ir a…" aria-keyshortcuts="Control+k Meta+k"><span className="sm:hidden">Buscar</span><span className="hidden sm:inline">Buscar o ir a…</span></Button></DialogTrigger>
    <DialogContent className="pulso-entrada">
      <DialogTitle>Buscar o ir a una pantalla</DialogTitle>
      <DialogDescription>Ctrl+K o ⌘K abre la paleta. Usa las flechas para elegir y Enter para abrir.</DialogDescription>
      <Command shouldFilter={false} label="Buscar pantallas, contactos o conversaciones" loop>
        <CommandInput aria-label="Buscar pantallas, contactos o conversaciones" placeholder="Nombre, teléfono o texto de un mensaje…" value={q} onValueChange={setQ} />
        <CommandList aria-label="Destinos y resultados">
          {loading && <p role="status" className="p-3 text-dato text-muted">Buscando…</p>}
          {error && <AvisoResultado persistente>{error}</AvisoResultado>}
          <CommandEmpty className="p-3 text-dato text-muted">Sin coincidencias. Prueba con otra palabra.</CommandEmpty>
          <CommandGroup heading="Pantallas">{nav.filter((n) => normal(n.label).includes(normal(q))).map((n) => <CommandItem key={n.path} value={`pagina:${n.path}`} onSelect={() => go(n.path)}>{n.label}</CommandItem>)}</CommandGroup>
          {!!contacts.length && <CommandGroup heading="Contactos">{contacts.map((c) => <CommandItem key={c.id} value={`contacto:${c.id}`} onSelect={() => go(`/contactos/${c.id}`)}><span>{c.name ?? 'Contacto sin nombre'}</span><span className="font-mono text-muted">{c.phone}</span></CommandItem>)}</CommandGroup>}
          {!!conversations.length && <CommandGroup heading="Conversaciones">{conversations.map((c) => <CommandItem key={c.conversationId} value={`conversacion:${c.conversationId}`} onSelect={() => go(`/bandeja?conversationId=${encodeURIComponent(c.conversationId)}`)}>Abrir conversación<span className="truncate text-muted">{c.snippet}</span></CommandItem>)}</CommandGroup>}
        </CommandList>
      </Command>
    </DialogContent>
  </Dialog>;
}
