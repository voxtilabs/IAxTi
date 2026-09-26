'use client';

import { useRef, useState } from 'react';
import { FileText, Upload } from 'lucide-react';
import { AvisoResultado, cn, useArrastre, useSession } from '@iaxti/ui/react';
import { apiFetch } from '../lib/api';
import { selectedTenant } from './tenant-switcher';

/**
 * Subir un PDF al conocimiento del negocio (#522).
 *
 * La zona de arrastre viene del bloque `file-upload-04` de blocks.so (MIT,
 * github.com/ephraimduncan/blocks) y lo que se conserva es la FORMA: el
 * recuadro punteado, el «arrastra o elige», el archivo con su peso y la barra.
 * El gesto en sí salió de acá a `useArrastre` (#561) para que la bandeja lo
 * use también: dos copias del mismo `onDrop` se separan en el primer arreglo.
 * Lo que se cambió, y por qué:
 *
 * - Pulso en vez de shadcn crudo: `rounded-campo` y `border-line-strong` en
 *   vez de `rounded-md border-input`, y los tamaños de la escala.
 * - Los avisos van por `AvisoResultado`, que es el envoltorio de este
 *   producto sobre el toast — no un `toast.error` suelto como el bloque.
 * - Sin `Progress` de shadcn: un `<progress>` con las clases de Pulso, el
 *   mismo que usa la puesta en marcha.
 * - Y el progreso es REAL. El bloque lo simula con un `setInterval` que sube
 *   5 % cada 200 ms, que para una demo está bien y para un PDF de 18 MB es
 *   mentirle a alguien que está esperando.
 *
 * El archivo va del navegador DERECHO a R2 con una URL firmada; la API solo
 * dice dónde ponerlo y después registra la fuente. Un PDF de 20 MB por el
 * cuerpo de una petición sería tiempo de servidor y un límite de tamaño que
 * habría que subir en dos capas.
 */

const MAX_MB = 20;

type Estado =
  | { fase: 'vacio' }
  | { fase: 'subiendo'; nombre: string; bytes: number; pct: number }
  | { fase: 'indexando'; nombre: string; bytes: number }
  | { fase: 'error'; mensaje: string };

function peso(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Sube con XMLHttpRequest y no con `fetch`, que es lo único raro acá y tiene
 * un motivo: `fetch` no informa el progreso de SUBIDA. Para un PDF de 18 MB
 * por una conexión de local comercial, la diferencia entre una barra que
 * avanza y una que no es que la persona no piense que se colgó.
 */
function subirConProgreso(
  url: string,
  archivo: File,
  onProgreso: (pct: number) => void,
): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/pdf');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgreso(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolver()
        : rechazar(new Error(`El archivo no se pudo guardar (${xhr.status}).`));
    xhr.onerror = () => rechazar(new Error('Se cortó la subida. Revisa tu conexión.'));
    xhr.send(archivo);
  });
}

export function SubirPdf({ alTerminar }: { alTerminar: () => void }) {
  const { config, session } = useSession();
  const [estado, setEstado] = useState<Estado>({ fase: 'vacio' });
  const campo = useRef<HTMLInputElement>(null);
  const arrastre = useArrastre({ alRecibir: (archivo) => void recibir(archivo) });

  async function recibir(archivo: File | undefined) {
    if (!archivo || !session) return;
    const tenant = selectedTenant();
    if (!tenant) return;
    if (!/\.pdf$/i.test(archivo.name)) {
      setEstado({
        fase: 'error',
        mensaje: 'Por acá entran PDF. Para una planilla usa el catálogo, y para texto pégalo.',
      });
      return;
    }
    if (archivo.size > MAX_MB * 1024 * 1024) {
      setEstado({
        fase: 'error',
        mensaje: `Ese PDF pesa ${peso(archivo.size)} y el máximo es ${MAX_MB} MB.`,
      });
      return;
    }
    try {
      setEstado({ fase: 'subiendo', nombre: archivo.name, bytes: archivo.size, pct: 0 });
      const destino = await apiFetch<{ key: string; uploadUrl: string }>(
        config,
        session,
        tenant,
        '/knowledge/sources/pdf/destino',
        { method: 'POST', body: JSON.stringify({ filename: archivo.name, sizeBytes: archivo.size }) },
      );
      await subirConProgreso(destino.uploadUrl, archivo, (pct) =>
        setEstado({ fase: 'subiendo', nombre: archivo.name, bytes: archivo.size, pct }),
      );
      // Indexar es otra espera, y se dice aparte: leer un PDF y embeberlo
      // tarda, y una barra al 100 % que no avanza se lee como colgada.
      setEstado({ fase: 'indexando', nombre: archivo.name, bytes: archivo.size });
      await apiFetch(config, session, tenant, '/knowledge/sources/pdf', {
        method: 'POST',
        body: JSON.stringify({ key: destino.key, name: archivo.name.replace(/\.pdf$/i, '') }),
      });
      setEstado({ fase: 'vacio' });
      if (campo.current) campo.current.value = '';
      alTerminar();
    } catch (err) {
      setEstado({ fase: 'error', mensaje: (err as Error).message });
    }
  }


  if (estado.fase === 'subiendo' || estado.fase === 'indexando') {
    return (
      <div className="flex flex-col gap-3 rounded-campo border border-line bg-rest px-4 py-3">
        <div className="flex items-center gap-3">
          <FileText aria-hidden className="size-5 shrink-0 text-action-text" />
          <span className="min-w-0 flex-1 truncate text-dato text-ink">{estado.nombre}</span>
          <span className="dato shrink-0 text-rotulo text-muted">{peso(estado.bytes)}</span>
        </div>
        {estado.fase === 'subiendo' ? (
          <>
            <progress
              aria-label="Subida del PDF"
              className="h-2 w-full appearance-none overflow-hidden rounded-boton border-0 bg-rest [&::-webkit-progress-bar]:bg-rest [&::-webkit-progress-value]:bg-action [&::-moz-progress-bar]:bg-action"
              max={100}
              value={estado.pct}
            />
            <p className="text-rotulo text-muted">Subiendo… {estado.pct}%</p>
          </>
        ) : (
          <p className="text-rotulo text-muted">
            Subido. Leyendo el documento y armando el índice — esto puede tardar un rato.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        {...arrastre.props}
        className={cn(
          'flex justify-center rounded-campo border border-dashed bg-field px-6 py-8',
          // Resaltar mientras hay algo encima: antes no había ninguna señal, así
          // que no se sabía si el recuadro estaba recibiendo o no (#561).
          arrastre.arrastrando ? 'border-action bg-action-soft' : 'border-line-strong',
        )}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Upload aria-hidden className="size-8 text-muted" />
          <p className="text-dato text-body">
            Arrastra tu PDF aquí, o{' '}
            <label className="cursor-pointer font-medium text-action-text hover:underline">
              elige un archivo
              <input
                ref={campo}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => void recibir(e.target.files?.[0])}
              />
            </label>
          </p>
          <p className="text-rotulo text-muted">
            Una lista de precios, un menú, tus políticas. Hasta {MAX_MB} MB.
          </p>
        </div>
      </div>
      {estado.fase === 'error' && <AvisoResultado tono="error">{estado.mensaje}</AvisoResultado>}
      <p className="text-rotulo text-muted">
        Si el PDF es un escaneo o una foto, no sale texto: en ese caso pega el contenido a mano.
      </p>
    </div>
  );
}
