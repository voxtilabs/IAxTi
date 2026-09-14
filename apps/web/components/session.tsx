'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { PublicConfig } from '../lib/config';

interface SessionState {
  supabase: SupabaseClient;
  session: Session | null;
  loading: boolean;
  config: PublicConfig;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const supabase = useMemo(
    () => createClient(config.supabaseUrl, config.supabaseAnonKey),
    [config.supabaseUrl, config.supabaseAnonKey],
  );
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  return <Ctx.Provider value={{ supabase, session, loading, config }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession fuera de SessionProvider');
  return ctx;
}

/** Redirige a /login si no hay sesión (tras cargarla). */
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  useEffect(() => {
    if (!loading && !session) window.location.href = '/login';
  }, [loading, session]);
  if (loading) return <p className="p-8 text-muted">Cargando tu sesión…</p>;
  if (!session) return null;
  return <>{children}</>;
}
