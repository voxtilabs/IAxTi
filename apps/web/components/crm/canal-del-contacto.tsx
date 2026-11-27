'use client';

import { FileSpreadsheet, MessageSquare, UserPlus, type LucideIcon } from 'lucide-react';

/**
 * Por dónde entró la persona (#1395).
 *
 * El logo oficial de cada marca —el del kit de marca, sin redibujar— porque es
 * la forma en que el dueño reconoce el canal de un vistazo. Los que no son
 * marca (el chat del sitio, una planilla, un alta a mano) van con ícono lucide
 * en 16 px y trazo 1,5. `importado` y `manual` no son canales de conversación
 * sino de dónde salió el contacto, y viven en el mismo mapa para que la lista,
 * la ficha y la historia digan lo mismo.
 */
const COMO_SE_VE: Record<string, { etiqueta: string; logo: string | null; icono: LucideIcon | null }> = {
  whatsapp: { etiqueta: 'WhatsApp', logo: '/marca/whatsapp-icon.svg', icono: null },
  instagram: { etiqueta: 'Instagram', logo: '/marca/instagram-icon.svg', icono: null },
  messenger: { etiqueta: 'Messenger', logo: '/marca/messenger-icon.svg', icono: null },
  webchat: { etiqueta: 'Chat del sitio', logo: null, icono: MessageSquare },
  importado: { etiqueta: 'Importado', logo: null, icono: FileSpreadsheet },
  manual: { etiqueta: 'Agregado a mano', logo: null, icono: UserPlus },
  // No es el origen de un contacto, pero sí el canal de una conversación: la
  // historia de la ficha lo muestra igual, con su nombre de persona.
  simulador: { etiqueta: 'Número de demostración', logo: null, icono: MessageSquare },
};

/** El nombre legible del canal, para cuando hace falta solo el texto. */
export function etiquetaDelCanal(canal: string): string {
  return COMO_SE_VE[canal]?.etiqueta ?? canal;
}

/** Logo o ícono + etiqueta. El texto lleva el significado; la marca, el reconocimiento. */
export function CanalDelContacto({ canal }: { canal: string }) {
  const vista = COMO_SE_VE[canal];
  const Icono = vista?.icono ?? MessageSquare;
  return (
    <span className="inline-flex items-center gap-2 text-body">
      {vista?.logo ? (
        <img src={vista.logo} alt="" className="size-4" />
      ) : (
        <Icono className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
      )}
      <span>{etiquetaDelCanal(canal)}</span>
    </span>
  );
}
