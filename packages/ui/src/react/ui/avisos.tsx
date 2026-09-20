'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';

export { toast } from 'sonner';

export function Avisos() {
  return <Toaster containerAriaLabel="Avisos de resultado" position="bottom-right" closeButton duration={6000} gap={12} toastOptions={{
    unstyled: true,
    closeButtonAriaLabel: 'Cerrar aviso',
    classNames: {
      toast: 'pulso-aviso flex w-full items-center gap-3 rounded-campo border border-line-strong bg-raised p-4 font-body text-dato text-ink',
      description: 'text-body', title: 'font-medium',
      success: '!border-good-soft-br !bg-good-soft !text-good-text',
      error: '!border-bad-soft-br !bg-bad-soft !text-bad-text',
      warning: '!border-warn-soft-br !bg-warn-soft !text-warn-text',
      closeButton: 'min-h-control min-w-control rounded-boton border border-line-strong bg-field text-ink',
      actionButton: 'min-h-control rounded-boton bg-action px-4 text-white',
      cancelButton: 'min-h-control rounded-boton border border-line-strong px-4 text-ink',
    },
  }} />;
}

/** Puente para las pantallas que conservan su último resultado en estado React. */
export function AvisoResultado({ children, persistente = false, tono = 'warning' }: { children: ReactNode; persistente?: boolean; tono?: 'success' | 'error' | 'warning' }) {
  const id = useId();
  useEffect(() => {
    toast[tono](children, { id });
    return () => { toast.dismiss(id); };
  }, [children, id, tono]);
  // Un error que sustituye la pantalla necesita conservar una explicación.
  return persistente ? <section role="status" className="rounded-campo border border-warn-soft-br bg-warn-soft p-4 text-dato text-warn-text">{children}</section> : null;
}
