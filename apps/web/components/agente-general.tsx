'use client';

/**
 * El Agente General en su popup, desde cualquier pantalla (#493, ADR-0025).
 *
 * De 505 líneas quedaron estas (#1129): el hilo se fue a `agente/estado.tsx`
 * y la conversación a `agente/conversacion.tsx`, porque ahora también vive
 * incrustada arriba de «Tu asistente» — que es la pantalla que ADR-0025 dice
 * que TIENE que ser esta conversación.
 *
 * Las dos son la MISMA: mismo hilo, mismo agente. Hablar acá y abrir la
 * pantalla continúa lo mismo, y al revés. Dos chats con IAxTi que no se
 * acuerdan uno del otro serían dos asistentes con dos memorias.
 */
import { Sparkles } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@iaxti/ui/react';
import { Conversacion } from './agente/conversacion';
import { useAgente } from './agente/estado';

export function AgenteGeneral() {
  const { abierto, setAbierto } = useAgente();
  return (
    <Dialog open={abierto} onOpenChange={setAbierto}>
      <Button
        variant="fantasma"
        onClick={() => setAbierto(true)}
        aria-keyshortcuts="Control+i Meta+i"
        aria-label="Pedirle algo a IAxTi"
      >
        <Sparkles aria-hidden className="size-4 text-action-text" />
        <span className="hidden sm:inline">Pídeselo a IAxTi</span>
      </Button>
      <DialogContent className="pulso-entrada flex max-h-[min(78vh,640px)] w-[calc(100vw-24px)] max-w-2xl flex-col gap-0 p-0">
        <div className="flex flex-col gap-1 border-b border-line px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden className="size-4 text-action-text" />
            Pídeselo a IAxTi
          </DialogTitle>
          <DialogDescription>
            Configura tu negocio conversando. Lo que no se puede deshacer te lo muestra antes y
            espera que lo apruebes.
          </DialogDescription>
        </div>
        <Conversacion />
      </DialogContent>
    </Dialog>
  );
}
