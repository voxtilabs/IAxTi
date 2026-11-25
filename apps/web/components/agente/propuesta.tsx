'use client';

/**
 * La tarjeta «Necesito tu visto bueno» del asistente (#1388).
 *
 * Es el momento en que se le pide a la persona que apruebe algo, así que lo
 * que muestra tiene que poder leerlo quien atiende un local, no quien escribió
 * la herramienta. Antes dibujaba los argumentos crudos —`promptName`,
 * `fallbackSystemPrompt`, un JSON de límites— y aprobar era apretar «Hazlo» a
 * ciegas.
 *
 * Por herramienta hay un mapa con lo que la persona DECIDE, en sus palabras.
 * Todo lo demás no se esconde: va plegado en «Ver detalle técnico», porque lo
 * que se aprueba tiene que poder revisarse entero. Una herramienta sin mapa se
 * muestra como siempre: inventar rótulos para algo que no conocemos sería peor.
 */
import { Badge, Button } from '@iaxti/ui/react';
import type { PropuestaDto } from './estado';

interface Campo {
  clave: string;
  rotulo: string;
  /** Traduce valores cerrados (un enum) a lo que significan. */
  valores?: Record<string, string>;
}

/** Lo que la persona decide, por herramienta. El resto va al detalle técnico. */
const LO_QUE_DECIDE: Record<string, Campo[]> = {
  'agents.create': [
    { clave: 'name', rotulo: 'Nombre' },
    { clave: 'personality', rotulo: 'Cómo habla' },
    { clave: 'objetivoDetalle', rotulo: 'Qué hace' },
    {
      clave: 'defaultMode',
      rotulo: 'Modo',
      valores: {
        assist: 'Te propone y tú confirmas',
        autonomous: 'Responde solo',
        off: 'Apagado',
      },
    },
  ],
};
LO_QUE_DECIDE['agents.update'] = LO_QUE_DECIDE['agents.create'];

const comoTexto = (valor: unknown) => (typeof valor === 'object' && valor !== null ? JSON.stringify(valor) : String(valor));

/** Un valor vacío no aporta nada a quien decide: ni «[]» ni «{}» ni «». */
const vacio = (valor: unknown) =>
  valor === null ||
  valor === undefined ||
  valor === '' ||
  (Array.isArray(valor) && valor.length === 0) ||
  (typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor as object).length === 0);

function Filas({ filas, tecnico }: { filas: Array<[string, unknown]>; tecnico?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-dato">
      {filas.map(([clave, valor]) => (
        <div key={clave} className="col-span-2 grid grid-cols-subgrid">
          <dt className={tecnico ? 'dato text-rotulo text-muted' : 'text-rotulo text-warn-text'}>{clave}</dt>
          <dd className={tecnico ? 'dato break-words text-body' : 'break-words text-ink'}>{comoTexto(valor)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Lo que el dueño ve de una acción: sus datos, no la ruta. */
export function Propuesta({
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
  const argumentos = propuesta.argumentos ?? {};
  const mapa = LO_QUE_DECIDE[propuesta.herramienta];

  let principales: Array<[string, unknown]>;
  let tecnicas: Array<[string, unknown]> = [];
  if (mapa) {
    const usadas = new Set(mapa.map((c) => c.clave));
    principales = mapa
      .filter((c) => !vacio(argumentos[c.clave]))
      .map((c) => {
        const valor = argumentos[c.clave];
        return [c.rotulo, c.valores?.[String(valor)] ?? valor];
      });
    tecnicas = Object.entries(argumentos).filter(([clave]) => !usadas.has(clave));
  } else {
    principales = Object.entries(argumentos);
  }

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-tarjeta border border-warn-soft-br bg-warn-soft p-4">
      <p className="flex flex-wrap items-center gap-2">
        <strong className="font-display text-dato font-semibold text-ink">
          {resuelta === 'aplicada' ? 'Hecho' : resuelta === 'descartada' ? 'No se hizo' : 'Necesito tu visto bueno'}
        </strong>
        <Badge role={resuelta === 'descartada' ? 'neutral' : resuelta ? 'good' : 'warn'}>{propuesta.descripcion}</Badge>
      </p>
      {principales.length > 0 && <Filas filas={principales} />}
      {tecnicas.length > 0 && (
        <details className="text-rotulo text-muted">
          <summary className="cursor-pointer select-none">Ver detalle técnico</summary>
          <div className="mt-2">
            <Filas filas={tecnicas} tecnico />
          </div>
        </details>
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
