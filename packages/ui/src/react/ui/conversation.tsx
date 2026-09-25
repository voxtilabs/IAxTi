'use client';

import type { ComponentProps } from 'react';
import { useCallback } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from './button';
import { IconoChevronAbajo } from './icons';
import { cn } from './cn';

/**
 * `Conversation` de los AI Elements del AI SDK de Vercel, tematizado Pulso.
 *
 * No está escrito acá: viene del registro oficial
 * (`https://registry.ai-sdk.dev/conversation.json`). Lo único que se cambió
 * son las clases de color —los tokens de shadcn por los de Pulso— y los
 * iconos, porque los nuestros están embebidos como TSX.
 *
 * Importa traerlo hecho y no escribirlo: el "pegado al fondo mientras
 * escribe, pero suelto si el usuario sube a leer" es un problema con más
 * casos de los que parece (rueda del mouse, cambio de tamaño, texto que
 * llega de a poco), y `use-stick-to-bottom` los tiene resueltos.
 */
export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-5 p-4', className)} {...props} />
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const alFondo = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  if (isAtBottom) return null;
  return (
    <Button
      aria-label="Ir al final de la conversación"
      // Sin sombra: este botón vive DENTRO de un overlay que ya flota, y una
      // sombra dentro de otra no dice nada (ADR-0018). El original de los AI
      // Elements no la traía; la puse yo al portarlo y el guard la cazó.
      className={cn('absolute bottom-3 left-1/2 -translate-x-1/2', className)}
      onClick={alFondo}
      size="icono"
      type="button"
      variant="secundario"
      {...props}
    >
      <IconoChevronAbajo className="h-4 w-4" />
    </Button>
  );
};
