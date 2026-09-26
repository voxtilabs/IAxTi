import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * `Message` de los AI Elements del AI SDK de Vercel, tematizado Pulso.
 *
 * Del registro oficial (`https://registry.ai-sdk.dev/message.json`), con dos
 * cambios: los tokens de color son los de Pulso, y no se trae
 * `MessageResponse` —que renderiza markdown con `streamdown`— porque el
 * Agente General contesta en prosa corta y no vale sumar un motor de
 * markdown para eso.
 *
 * El patrón que importa es el de los grupos: el contenedor se marca
 * `is-user` o `is-assistant` y el contenido se estila con
 * `group-[.is-user]:…`. Así el globo del que escribe y el del que responde
 * salen del MISMO componente, sin una rama de código por rol.
 */
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: 'user' | 'assistant' | 'system';
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      'group flex w-full max-w-[95%] flex-col gap-2',
      from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      'flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden whitespace-pre-wrap text-cuerpo',
      'group-[.is-user]:ml-auto group-[.is-user]:rounded-tarjeta group-[.is-user]:rounded-br-campo',
      'group-[.is-user]:border group-[.is-user]:border-action-soft-br group-[.is-user]:bg-action-soft',
      'group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-ink',
      'group-[.is-assistant]:text-body',
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
