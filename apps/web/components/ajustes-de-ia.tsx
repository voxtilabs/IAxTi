'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AvisoResultado,
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Seccion,
  Skeleton,
  Switch,
  useSession,
} from '@iaxti/ui/react';
import { apiFetch, mensajeDeError } from '../lib/api';
import { useSelectedTenant } from './tenant-switcher';

/**
 * Los ajustes de IA del negocio (#536).
 *
 * Dos cosas, y las dos son promesas que el producto ya hacía y no se podían
 * cumplir: `settings.ia` se LEÍA en `iaSettings` desde el principio y ninguna
 * ruta lo escribía, así que el resguardo de ADR-0025 §7 —un cliente que exige
 * por escrito un único proveedor de IA— solo se podía aplicar con un UPDATE a
 * mano en producción.
 *
 * Lo que NO está acá, a propósito: el modelo por tarea y el modelo económico.
 * Son perillas de quien conoce los modelos, y ADR-0025 puso al Agente General
 * como vía de configuración justamente para no llenar la interfaz de cosas que
 * un dueño de pyme no puede evaluar.
 */

/** «Cualquiera» como valor del desplegable: Radix no acepta `value=""`. */
const CUALQUIERA = '__cualquiera__';

const NOMBRE: Record<string, string> = {
  google: 'Google (Gemini)',
  anthropic: 'Anthropic (Claude)',
  glm: 'GLM',
  openai: 'OpenAI (GPT)',
};

interface AjustesDto {
  soloProveedor: string | null;
  redactPII: boolean;
  disponibles: string[];
  /** Con qué se está atendiendo DE VERDAD cada tarea, ahora (#858). */
  atendiendo?: Record<string, { provider: string; model: string }>;
}

export function AjustesDeIa() {
  const { config, session } = useSession();
  const tenant = useSelectedTenant();
  const [ajustes, setAjustes] = useState<AjustesDto | null | undefined>();
  const [proveedor, setProveedor] = useState(CUALQUIERA);
  const [taparPii, setTaparPii] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      const r = await apiFetch<AjustesDto>(config, session, tenant, '/agents/ajustes');
      setAjustes(r);
      setProveedor(r.soloProveedor ?? CUALQUIERA);
      setTaparPii(r.redactPII);
    } catch {
      // Sin `tenant.settings` esto responde 403, y no es un error que mostrar:
      // quien atiende no configura la IA del negocio y no tiene por qué ver un
      // aviso rojo por entrar a su propia pantalla.
      setAjustes(null);
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  const guardar = async () => {
    if (!session || !tenant || guardando) return;
    setGuardando(true);
    try {
      const r = await apiFetch<AjustesDto>(config, session, tenant, '/agents/ajustes', {
        method: 'PUT',
        body: JSON.stringify({
          soloProveedor: proveedor === CUALQUIERA ? null : proveedor,
          redactPII: taparPii,
        }),
      });
      setProveedor(r.soloProveedor ?? CUALQUIERA);
      setTaparPii(r.redactPII);
      setAviso(null);
    } catch (err) {
      setAviso(mensajeDeError(err));
    } finally {
      setGuardando(false);
    }
  };

  if (ajustes === null) return null;
  if (ajustes === undefined) return <Skeleton className="mt-6 h-40" />;

  return (
    <Seccion aria-label="Ajustes de IA del negocio">
      <span className="rotulo">Proveedor y datos</span>
      <p className="mt-2 max-w-prose text-sm text-body">
        Son las cuentas de IAxTi: acá no se agrega una cuenta ni una clave propia.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Usar solamente
          <Select value={proveedor} onValueChange={setProveedor}>
            <SelectTrigger aria-label="Proveedor único" className="h-control w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CUALQUIERA}>El que mejor rinda (recomendado)</SelectItem>
              {ajustes.disponibles.map((p) => (
                <SelectItem key={p} value={p}>{NOMBRE[p] ?? p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-3 text-sm font-medium text-ink">
          <Switch checked={taparPii} onCheckedChange={setTaparPii} aria-label="Tapar datos personales" />
          Tapar datos personales en el registro técnico
        </label>
        <Button variant="secundario" disabled={guardando} onClick={() => void guardar()}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>

      {/* Que la transcripción es la excepción hay que decirlo ANTES, no cuando
          una nota de voz llegue sin texto: el proveedor único se respeta salvo
          donde ese proveedor no puede, y eso es capacidad y no preferencia. */}
      {proveedor !== CUALQUIERA && (
        <p className="mt-3 max-w-prose text-rotulo text-muted">
          Las notas de voz son la excepción: si el proveedor que elegiste no transcribe audio, esa
          tarea usa el que sí puede. El mensaje llega igual; lo que cambia es quién lo pasa a texto.
        </p>
      )}
      {ajustes.disponibles.length === 0 && (
        <p className="mt-3 text-rotulo text-muted">
          Este ambiente todavía no tiene ningún proveedor configurado.
        </p>
      )}

      <ConQuienTeAtiende atendiendo={ajustes.atendiendo} />
      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}
    </Seccion>
  );
}

/**
 * Con qué se está atendiendo, de verdad (#858).
 *
 * Lo que el negocio ELIGE y lo que el producto USA no siempre coinciden, y
 * las tres razones pasan sin que nadie las anuncie:
 *
 * - el defecto de la plataforma, que no es una preferencia suya;
 * - el respaldo, cuando el proveedor elegido no tiene credencial acá;
 * - la transcripción, que no puede ir a un proveedor de solo texto aunque el
 *   negocio haya pedido ese y nada más.
 *
 * El caso que esto resuelve: alguien pidió «solo Gemini», ve que sus notas de
 * voz llegan transcritas igual, y no tiene cómo saber si eso es un error o
 * está previsto. Decirlo acá es más barato que explicarlo después.
 *
 * Se agrupa POR PROVEEDOR y no se lista tarea por tarea: nueve filas con
 * nombres internos —`configuracion_conversada`— no es información para un
 * dueño de pyme. Lo que le importa es hacia qué empresas salen sus datos.
 */
function ConQuienTeAtiende({
  atendiendo,
}: {
  atendiendo?: Record<string, { provider: string; model: string }>;
}) {
  // Ausente y no vacío: una API vieja —durante un despliegue, el front nuevo
  // convive un rato con ella— no manda el campo, y mostrar «no te atiende
  // nadie» sería peor que no mostrar nada.
  if (!atendiendo || Object.keys(atendiendo).length === 0) return null;

  const porProveedor = new Map<string, number>();
  for (const { provider } of Object.values(atendiendo)) {
    porProveedor.set(provider, (porProveedor.get(provider) ?? 0) + 1);
  }
  const total = Object.keys(atendiendo).length;
  const ordenados = [...porProveedor.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="mt-5 border-t border-line pt-4">
      <span className="rotulo">Hoy te atiende</span>
      <ul className="mt-2 flex flex-wrap gap-2">
        {ordenados.map(([proveedor, cuantas]) => (
          <li key={proveedor}>
            <Badge role="neutral">
              {NOMBRE[proveedor] ?? proveedor}
              {cuantas === total ? ' · en todo' : ` · ${cuantas} de ${total}`}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-prose text-rotulo text-muted">
        Lo que usa ahora mismo, que puede no ser lo que elegiste: si el que elegiste no está
        disponible, se usa otro.
      </p>
    </div>
  );
}
