'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { AvisoResultado, Button, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiDescargarBinario, apiFetch } from '../lib/api';

/**
 * Llevarse los datos del negocio (#447, #222).
 *
 * `GET /exportacion` existe desde #222 y su ruta no la llamaba nadie. La
 * exportación la exigen tres cosas distintas: la cancelación en un clic
 * (SPEC §6) la pide ANTES de cerrar, el borrado a los 90 días la ofrece
 * antes de eliminar, y la Ley 21.719 la pide como portabilidad.
 *
 * Las tres suponen que el dueño puede apretar un botón. No podía.
 *
 * Va en Facturación y no en un menú de sistema porque el momento en que
 * alguien quiere llevarse sus datos es el mismo en que está mirando cuánto
 * paga.
 */
interface Exportacion {
  generadoEl: string;
  resumen: Record<string, number>;
  truncadas: string[];
  fuera: Record<string, string>;
}

export function LlevarseLosDatos() {
  const { config, session } = useSession();
  const tenant = selectedTenant();
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ultima, setUltima] = useState<Exportacion | null>(null);

  if (!tenant) return null;

  const exportar = async () => {
    if (!session) return;
    setAviso(null);
    setOcupado(true);
    try {
      /**
       * Un ZIP que se abre con doble clic, no un `.json` (#583).
       *
       * Lo que bajaba antes era un JSON armado en el navegador, y dentro los
       * adjuntos eran llaves PELADAS de R2 —rutas privadas del bucket— con un
       * comentario que decía «los archivos se piden aparte». No había ninguna
       * ruta que los pidiera: el negocio se llevaba la referencia a sus fotos,
       * cotizaciones y comprobantes, y no las fotos.
       *
       * Ahora el paquete lo arma el servidor, que es el único que puede firmar
       * los enlaces de descarga, y adentro va un `LEEME.txt` que dice qué hay,
       * qué falta y hasta cuándo sirven esos enlaces.
       *
       * `/me/exportacion` (JSON) se queda viva: hay SDK generado contra ella.
       * Esta pantalla usa `.zip`, que es lo que una persona puede abrir.
       */
      const { blob, nombre } = await apiDescargarBinario(
        config,
        session,
        tenant,
        // `/me/exportacion.zip` y no `/exportacion.zip`: vive en el controlador
        // de "lo mío". Mi propio inventario de rutas decía `/exportacion`
        // porque tomaba el primer @Controller del archivo, y ese archivo tiene
        // cinco. El guard de rutas lo cazó al primer intento.
        '/me/exportacion.zip',
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombre;
      a.click();
      URL.revokeObjectURL(url);
      // El resumen de la pantalla sigue saliendo del JSON: es el mismo dato y
      // así se puede mostrar sin volver a armar el paquete. Es una llamada más
      // y es deliberada — el zip no se puede leer desde el navegador.
      setUltima(
        await apiFetch<Exportacion & Record<string, unknown>>(
          config, session, tenant, '/me/exportacion',
        ),
      );
    } catch (e) {
      setAviso(e instanceof Error ? e.message : 'No pudimos armar la exportación.');
    } finally {
      setOcupado(false);
    }
  };

  const filas = ultima ? Object.entries(ultima.resumen).filter(([, n]) => n > 0) : [];

  return (
    <section className="mt-8 rounded-campo border border-line bg-rest p-4">
      <p className="flex items-center gap-2">
        <Download aria-hidden className="size-4 text-muted" />
        <span className="rotulo">Llevarte tus datos</span>
      </p>
      <p className="mt-1 max-w-prose text-sm text-body">
        Todo lo tuyo en un archivo: contactos, conversaciones, oportunidades, citas y facturas. Es
        tuyo y te lo puedes llevar cuando quieras, no solo si te vas.
      </p>

      <Button className="mt-3" variant="secundario" disabled={ocupado} onClick={() => void exportar()}>
        {ocupado ? 'Armando el archivo…' : 'Descargar todo'}
      </Button>

      {ultima && (
        <div className="mt-3 text-sm text-body">
          <p className="font-medium text-ink">Se descargó esto:</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted">
            {filas.map(([tabla, n]) => (
              <li key={tabla}>
                {n} {tabla.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
          {/* Una exportación incompleta se dice en voz alta: el resumen
              contaría lo que salió y nadie notaría lo que faltó. */}
          {ultima.truncadas.length > 0 && (
            <p className="mt-2 rounded-campo border border-warn-soft-br bg-warn-soft px-3 py-2 text-warn-text">
              Quedó incompleta en {ultima.truncadas.join(', ')}: hay más de lo que cabe en un
              archivo. Escríbenos y te la mandamos completa.
            </p>
          )}
          {Object.keys(ultima.fuera).length > 0 && (
            // Lo que NO va, con su motivo. Sin esto, el que revisa cree que
            // el archivo lo trae todo.
            <details className="mt-2">
              <summary className="w-fit cursor-pointer text-action-text">Qué no incluye y por qué</summary>
              <ul className="mt-1 list-disc pl-5 text-muted">
                {Object.entries(ultima.fuera).map(([que, porque]) => (
                  <li key={que}>
                    <span className="text-body">{que.replace(/_/g, ' ')}</span>: {porque}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {aviso && (
        <AvisoResultado tono="error" persistente>
          {aviso}
        </AvisoResultado>
      )}
    </section>
  );
}
