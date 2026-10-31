'use client';

/**
 * La conversación con IAxTi: UNA, usada en los dos lugares (#1129).
 *
 * Vive en el popup —«Pídeselo a IAxTi», desde cualquier pantalla— y
 * incrustada arriba de «Tu asistente», que es la pantalla que ADR-0025 dice
 * que TIENE que ser esta conversación.
 *
 * No son dos chats: el hilo está en `estado.tsx` y este componente solo lo
 * dibuja. Copiarlo habría dejado dos conversaciones que se desincronizan, y
 * la que se desincroniza es siempre la que nadie está mirando.
 */
import { useEffect, useState } from 'react';
import {
  AvisoResultado,
  Badge,
  Button,
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Loader,
  Message,
  MessageContent,
  Textarea,
  toast,
} from '@iaxti/ui/react';
import { useAgente, type PropuestaDto } from './estado';

/** Lo que el dueño ve de una acción: sus datos, no la ruta. */
function Propuesta({
  propuesta,
  resuelta,
  onAplicar,
  aplicando,
}: {
  propuesta: PropuestaDto;
  resuelta?: 'aplicada' | 'descartada';
  onAplicar: (aplicar: boolean) => void;
  aplicando: boolean;
}) {
  const filas = Object.entries(propuesta.argumentos ?? {});
  return (
    <div className="mt-2 flex flex-col gap-3 rounded-tarjeta border border-warn-soft-br bg-warn-soft p-4">
      <p className="flex flex-wrap items-center gap-2">
        <strong className="font-display text-dato font-bold text-ink">
          {resuelta === 'aplicada'
            ? 'Hecho'
            : resuelta === 'descartada'
              ? 'No se hizo'
              : 'Necesito tu visto bueno'}
        </strong>
        <Badge role={resuelta === 'descartada' ? 'neutral' : resuelta ? 'good' : 'warn'}>
          {propuesta.descripcion}
        </Badge>
      </p>
      {filas.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-dato">
          {filas.map(([clave, valor]) => (
            <div key={clave} className="col-span-2 grid grid-cols-subgrid">
              <dt className="dato text-rotulo uppercase tracking-wide text-warn-text">{clave}</dt>
              <dd className="dato break-words text-ink">
                {typeof valor === 'object' ? JSON.stringify(valor) : String(valor)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!resuelta && (
        <span className="flex flex-wrap gap-2">
          <Button size="chico" disabled={aplicando} onClick={() => onAplicar(true)}>
            {aplicando ? 'Aplicando…' : 'Hazlo'}
          </Button>
          <Button size="chico" variant="secundario" disabled={aplicando} onClick={() => onAplicar(false)}>
            Mejor no
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * La espera, contada en voz alta (#688).
 *
 * Decía «Buscando entre sus herramientas…» y nada más, para siempre. El 28/09
 * NVIDIA se puso a encolar —`curl` pelado con «di hola» tardó 139 s y 178 s,
 * cuando la noche anterior tardaba 2— y eso se vio exactamente igual que el
 * producto roto: «es como que no hay IA conectada».
 *
 * Un spinner mudo no distingue «está pensando» de «esto no va a volver nunca».
 * El número sí: a los diez segundos se dice que está tardando más de lo normal,
 * y de quién es el problema —del proveedor, no de tu cuenta—.
 *
 * El segundero es del componente y no del padre: si viviera arriba, cada tic
 * volvería a dibujar la conversación entera.
 */
function Esperando() {
  const [segundos, setSegundos] = useState(0);
  useEffect(() => {
    const reloj = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(reloj);
  }, []);
  // A los 10 s avisaba que iba lento. En ESTE camino diez segundos son
  // normales: son hasta seis viajes al proveedor, no uno (#712). Avisar antes
  // de tiempo enseña a ignorar el aviso, que es justo lo contrario de para qué
  // está.
  const lento = segundos >= 30;
  return (
    <span className="flex flex-col gap-1 text-dato text-muted">
      <span className="flex items-center gap-2">
        <Loader size={14} /> Buscando entre sus herramientas…
        {segundos >= 3 ? <span className="font-mono">{segundos}s</span> : null}
      </span>
      {lento ? (
        <span>
          Está tardando más de lo normal. Buscar la herramienta y preparar la acción son varios
          viajes al proveedor de IA, y hoy va lento — no es algo de tu cuenta. Si no vuelve,
          ciérralo y pídeselo de nuevo.
        </span>
      ) : null}
    </span>
  );
}


export function Conversacion({ alto }: { alto?: string }) {
  const {
    turnos, texto, setTexto, pensando, aplicando, aviso, sugerencias,
    pedirSugerencias, preguntar, resolver, campo,
  } = useAgente();

  // Las de ESTA pantalla, al montarse. En el popup eso es al abrirlo; en la
  // pantalla, al entrar.
  useEffect(() => { pedirSugerencias(); }, [pedirSugerencias]);

  return (
    <>
      <Conversation className={alto ?? 'min-h-[220px]'}>
        <ConversationContent>
            {turnos.length === 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-cuerpo text-body">
                  Dime qué necesitas en tus palabras. Puedo revisar cómo va tu negocio, dejar
                  reglas que trabajen solas, armar tus embudos o cambiar cómo atiendes.
                </p>
                <ul className="flex flex-col gap-2">
                  {(sugerencias ?? []).map((e) => (
                    <li key={e}>
                      <Button variant="secundario" size="chico" onClick={() => void preguntar(e)}>
                        {e}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turnos.map((t, i) => (
              <Message key={`${i}-${t.content.slice(0, 12)}`} from={t.role}>
                {/* Los pasos: qué herramienta usó y de qué parte del producto.
                    Se muestran ARRIBA de la respuesta porque es el orden en
                    que pasaron, y porque explican de dónde salió lo que dice. */}
                {t.pasos && t.pasos.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {t.pasos.map((p, n) => (
                      <li
                        key={`${p.herramienta}-${n}`}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-campo border border-line bg-rest px-3 py-1.5"
                      >
                        <span className="dato text-rotulo text-ink">{p.herramienta}</span>
                        {p.modulo && <span className="dato text-rotulo text-action-text">{p.modulo}</span>}
                        {!p.ok && <Badge role="bad">no se pudo</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                <MessageContent>{t.content}</MessageContent>
                {/*
                  Copiar lo que redactó (#584).
                  
                  El agente escribe cosas para pegar en otra parte —un texto
                  para mandarle a un cliente, una descripción, un horario— y
                  hasta ahora había que seleccionarlo a mano dentro de un
                  popup, que es justo donde seleccionar sale mal.
                  
                  Solo en lo que dice ÉL: copiar lo que uno mismo escribió no
                  le sirve a nadie, y un botón que no sirve en la mitad de los
                  mensajes enseña a no mirar los botones.
                  
                  Mismo patrón que el rastro del error en la bandeja: con
                  confirmación de que se copió, y con el caso del navegador
                  que no deja —que existe, en contextos sin HTTPS o con el
                  permiso denegado— dicho en vez de callado.
                */}
                {t.role === 'assistant' && t.content.trim() !== '' && (
                  <button
                    type="button"
                    className="self-start text-rotulo text-action-text underline"
                    onClick={() => {
                      void navigator.clipboard
                        ?.writeText(t.content)
                        .then(() => toast.success('Copiado.'))
                        .catch(() =>
                          toast.error('Tu navegador no dejó copiar. Selecciónalo a mano.'),
                        );
                    }}
                  >
                    Copiar
                  </button>
                )}
                {t.propuesta && (
                  <Propuesta
                    propuesta={t.propuesta}
                    resuelta={t.resuelta}
                    aplicando={aplicando}
                    onAplicar={(aplicar) => void resolver(i, aplicar)}
                  />
                )}
              </Message>
            ))}

            {pensando && (
              <Message from="assistant">
                <MessageContent>
                  <Esperando />
                </MessageContent>
              </Message>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {/* `px-4` en angosto (#1133): con `px-6` fijos, el relleno del panel
            más el del compositor dejaban al campo ~130 px a 360. */}
        <div className="flex flex-col gap-2 border-t border-line px-4 py-4 sm:px-6">
          {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}
          {/* Apilado en angosto (#1133). En el popup esto vivía en un diálogo
              de `max-w-2xl` y la fila entraba; incrustado en una columna de
              680 que a 360 se vuelve ~300, no: «Pídele lo que necesitas»
              envolvía a dos líneas dentro de un campo de UNA, y la segunda
              quedaba cortada por la mitad.
              El botón ocupa el ancho abajo en vez de encogerse a un icono: es
              la acción de la pantalla y en el teléfono se aprieta con el
              pulgar. */}
          <form
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void preguntar(texto);
            }}
          >
            <Textarea
              ref={campo}
              rows={1}
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void preguntar(texto);
                }
              }}
              placeholder="Pídele lo que necesitas"
              aria-label="Pídele algo a IAxTi"
              className="max-h-32"
            />
            <Button type="submit" disabled={pensando || !texto.trim()}>
              Pedir
            </Button>
          </form>
        </div>
    </>
  );
}
