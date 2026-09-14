// El canal de una conversación, visible de un vistazo (#74). Los glifos son
// geométricos y monocromos a propósito: marcan de dónde viene el mensaje sin
// hacerse pasar por el logo de nadie, y el nombre viaja siempre como texto
// accesible — el color y la forma nunca son el único portador (Pulso).

export type CanalId = 'whatsapp' | 'instagram' | 'messenger' | 'webchat' | 'simulador';

export const NOMBRE_CANAL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
  webchat: 'Chat del sitio',
  simulador: 'Simulador',
};

export function nombreCanal(canal: string): string {
  return NOMBRE_CANAL[canal] ?? canal;
}

/**
 * Cómo se llama en pantalla quien escribe. Por Instagram y Messenger no llega
 * teléfono ni nombre: queda el canal y el final de su id, que es lo único que
 * hay. Mejor eso que una fila en blanco.
 */
export function nombreVisible(input: {
  name?: string | null;
  phone?: string | null;
  channel?: string | null;
  identity?: string | null;
}): string {
  if (input.name) return input.name;
  if (input.phone) return input.phone;
  const cola = (input.identity ?? '').slice(-6);
  if (input.channel && cola) return `${nombreCanal(input.channel)} · …${cola}`;
  return input.channel ? nombreCanal(input.channel) : 'Sin nombre';
}

function Glifo({ canal }: { canal: string }) {
  if (canal === 'instagram') {
    return (
      <>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17" cy="7" r="1.2" fill="currentColor" stroke="none" />
      </>
    );
  }
  if (canal === 'messenger') {
    return (
      <>
        <path d="M12 3c-5 0-9 3.7-9 8.3 0 2.6 1.3 4.9 3.3 6.4V21l3-1.6c.9.2 1.8.4 2.7.4 5 0 9-3.7 9-8.3S17 3 12 3z" />
        <path d="M7.5 13.5l3-3.2 2.2 2.2 3.3-2.7-3 3.2-2.2-2.2-3.3 2.7z" fill="currentColor" stroke="none" />
      </>
    );
  }
  if (canal === 'webchat' || canal === 'simulador') {
    return <path d="M4 5h16v11H9l-5 4V5z" />;
  }
  // WhatsApp: burbuja con cola y el auricular insinuado.
  return (
    <>
      <path d="M4 20l1.3-3.8A8 8 0 1112 20a8 8 0 01-3.9-1L4 20z" />
      <path d="M9.2 9.3c.2 1.9 1.6 3.3 3.5 3.5l.8-1.1 1.7.8-.4 1.3c-2.6.2-5.3-2.5-5.1-5.1l1.3-.4.8 1.7-.6.4z" fill="currentColor" stroke="none" />
    </>
  );
}

export function CanalIcono({ canal, className }: { canal: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ?? 'h-4 w-4'}
    >
      <Glifo canal={canal} />
    </svg>
  );
}

/** Icono + nombre. El nombre puede ocultarse visualmente, nunca al lector. */
export function CanalChip({ canal, soloIcono }: { canal: string; soloIcono?: boolean }) {
  const nombre = nombreCanal(canal);
  return (
    <span className="inline-flex items-center gap-1 text-muted" title={nombre}>
      <CanalIcono canal={canal} />
      <span className={soloIcono ? 'sr-only' : 'text-xs'}>{nombre}</span>
    </span>
  );
}
