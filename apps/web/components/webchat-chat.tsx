'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, IconoEnviar, Input, Textarea, cn } from '@iaxti/ui/react';

// El chat del visitante (#46): vive en el iframe del widget, con Pulso.
// El primero puede ser anónimo; antes del segundo, nombre + teléfono o
// correo. Las respuestas del equipo llegan por sondeo.

interface Burbuja {
  de: 'yo' | 'equipo';
  body: string;
  id?: string;
}

export function WebchatChat({
  apiUrl,
  widgetId,
  page,
}: {
  apiUrl: string;
  widgetId: string;
  page: string;
}) {
  const base = `${apiUrl}/webchat/${widgetId}`;
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<Burbuja[]>([]);
  const [texto, setTexto] = useState('');
  const [pideIdentidad, setPideIdentidad] = useState(false);
  const [nombre, setNombre] = useState('');
  const [contacto, setContacto] = useState(''); // teléfono o correo
  const [aviso, setAviso] = useState<string | null>(null);
  const [apagado, setApagado] = useState(false);
  const ultimaRef = useRef<string | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, ...body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? 'Algo salió mal. Intenta de nuevo.');
      }
      return res.json();
    },
    [base, page],
  );

  // Sesión: una por widget en este navegador.
  useEffect(() => {
    const clave = `iaxti-webchat-${widgetId}`;
    const guardada = (() => {
      try { return localStorage.getItem(clave); } catch { return null; }
    })();
    if (guardada) {
      setSessionId(guardada);
      return;
    }
    void post('/sessions', {})
      .then((s: { sessionId: string; welcomeMessage: string }) => {
        try { localStorage.setItem(clave, s.sessionId); } catch { /* privado */ }
        setSessionId(s.sessionId);
        setMensajes([{ de: 'equipo', body: s.welcomeMessage }]);
      })
      .catch(() => setApagado(true));
  }, [post, widgetId]);

  // Sondeo de respuestas del equipo.
  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      const after = ultimaRef.current ? `&after=${encodeURIComponent(ultimaRef.current)}` : '';
      void fetch(`${base}/messages?page=${encodeURIComponent(page)}&sessionId=${sessionId}${after}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((nuevos: Array<{ id: string; body: string | null; createdAt: string }>) => {
          if (!nuevos.length) return;
          ultimaRef.current = nuevos[nuevos.length - 1].createdAt;
          setMensajes((prev) => {
            const vistos = new Set(prev.map((m) => m.id));
            const frescos = nuevos
              .filter((n) => !vistos.has(n.id) && n.body)
              .map((n) => ({ de: 'equipo' as const, body: n.body!, id: n.id }));
            return frescos.length ? [...prev, ...frescos] : prev;
          });
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [base, page, sessionId]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: 'end' });
  }, [mensajes, pideIdentidad]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!sessionId || !texto.trim()) return;
    setAviso(null);
    const cuerpo = texto.trim();
    const visitante = pideIdentidad
      ? {
          name: nombre.trim() || undefined,
          phone: /^[+0-9 ()-]{8,}$/.test(contacto.trim()) ? contacto.trim() : undefined,
          email: contacto.includes('@') ? contacto.trim() : undefined,
        }
      : undefined;
    if (pideIdentidad && !visitante?.phone && !visitante?.email) {
      setAviso('Dinos tu teléfono o tu correo para seguir.');
      return;
    }
    try {
      const res = (await post('/messages', {
        sessionId,
        body: cuerpo,
        visitor: visitante,
      })) as { status: 'pending' | 'need_identity' | 'delivered' };
      setMensajes((prev) => [...prev, { de: 'yo', body: cuerpo }]);
      setTexto('');
      if (res.status === 'need_identity') {
        setPideIdentidad(true);
        setMensajes((prev) => [
          ...prev,
          { de: 'equipo', body: 'Para seguir, cuéntanos tu nombre y tu teléfono o correo. Así te respondemos aunque cierres esta página.' },
        ]);
        return;
      }
      if (res.status === 'delivered') setPideIdentidad(false);
    } catch (err) {
      setAviso((err as Error).message);
      if ((err as Error).message.includes('teléfono o tu correo')) setPideIdentidad(true);
    }
  }

  if (apagado) {
    return (
      <main className="flex h-screen items-center justify-center bg-bg p-6 text-center">
        <p className="text-sm text-muted">El chat no está disponible en este momento.</p>
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden rounded-bloque border border-line bg-bg">
      <header className="border-b border-line bg-raised px-4 py-3">
        <p className="font-display font-bold text-ink">Conversemos</p>
        <p className="text-xs text-muted">Te respondemos por aquí</p>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <ol className="flex flex-col gap-2">
          {mensajes.map((m, i) => (
            <li key={m.id ?? i} className={cn('flex', m.de === 'yo' ? 'justify-end' : 'justify-start')}>
              <p
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-tarjeta px-4 py-2 text-sm',
                  m.de === 'yo'
                    ? 'rounded-br-campo border border-action-soft-br bg-action-soft text-ink'
                    : 'rounded-bl-campo border border-line bg-raised text-body',
                )}
              >
                {m.body}
              </p>
            </li>
          ))}
        </ol>
        {pideIdentidad && (
          <div className="mt-3 flex flex-col gap-2 rounded-campo border border-line bg-raised p-3">
            <Input
              aria-label="Tu nombre"
              placeholder="Tu nombre"
              className="h-9 text-sm"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
            />
            <Input
              aria-label="Tu teléfono o correo"
              placeholder="Tu teléfono o correo"
              className="h-9 text-sm"
              value={contacto}
              onChange={(e) => setContacto(e.target.value)}
            />
          </div>
        )}
        {aviso && (
          <p role="alert" className="mt-3 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-xs text-warn-text">
            {aviso}
          </p>
        )}
        <div ref={finRef} />
      </div>

      <form onSubmit={enviar} className="flex items-end gap-2 border-t border-line p-3">
        <Textarea
          aria-label="Tu mensaje"
          placeholder="Escribe aquí…"
          rows={1}
          className="max-h-28 text-sm"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void enviar(e);
            }
          }}
        />
        <Button type="submit" size="icono" aria-label="Enviar" disabled={!texto.trim()} className="h-11 w-11">
          <IconoEnviar className="h-4 w-4" />
        </Button>
      </form>
    </main>
  );
}
