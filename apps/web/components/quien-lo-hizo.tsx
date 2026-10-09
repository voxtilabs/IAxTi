import type { Quien } from '@iaxti/sdk';

/**
 * Quién hizo algo, en una frase (#697).
 *
 * Nueve columnas guardaban el autor de cada acción y ninguna pantalla lo
 * mostraba. Esto existe una sola vez para que la frase sea una sola: seis
 * pantallas escribiéndola por su cuenta dan seis maneras distintas de decir lo
 * mismo, y una de ellas va a terminar mostrando el UUID.
 *
 * Las tres respuestas posibles, y ninguna es un identificador:
 *  - con nombre: «Carla».
 *  - sin perfil completado: «alguien del equipo» — sabemos que es del equipo,
 *    no cómo se llama, y decirlo así es más honesto que un id.
 *  - fuera del equipo: «alguien que ya no está en el equipo». Pasa de verdad:
 *    quien lanzó la campaña del mes pasado pudo haberse ido.
 */
export function nombreDeQuien(quien: Quien | null | undefined): string | null {
  if (!quien) return null;
  if (quien.nombre) return quien.nombre;
  // `enElEquipo` en null es ámbito plataforma: no se afirma pertenencia.
  if (quien.enElEquipo === false) return 'alguien que ya no está en el equipo';
  return 'alguien del equipo';
}

/**
 * La frase completa, con su fecha cuando la hay.
 *
 * `accion` va en pasado y sin sujeto: «Lanzada», «Apagada», «Aprobada». El
 * componente arma «Lanzada por Carla · 7 oct 2026».
 */
export function QuienLoHizo({
  accion,
  quien,
  cuando,
  className,
}: {
  accion: string;
  quien: Quien | null | undefined;
  cuando?: string | Date | null;
  className?: string;
}) {
  const nombre = nombreDeQuien(quien);
  if (!nombre && !cuando) return null;
  const fecha = cuando
    ? new Date(cuando).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;
  return <span className={className ?? 'text-xs text-muted'}>
    {nombre ? `${accion} por ${nombre}` : accion}
    {fecha && <> · <span className="font-mono">{fecha}</span></>}
  </span>;
}
