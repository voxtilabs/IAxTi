'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AvisoResultado,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useSession,
} from '@iaxti/ui/react';
import { apiFetch } from '../lib/api';
import { selectedTenant } from './tenant-switcher';

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
};

interface AjustesDto {
  soloProveedor: string | null;
  redactPII: boolean;
  disponibles: string[];
}

export function AjustesDeIa() {
  const { config, session } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [ajustes, setAjustes] = useState<AjustesDto | null | undefined>();
  const [proveedor, setProveedor] = useState(CUALQUIERA);
  const [taparPii, setTaparPii] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
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
      setAviso((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  if (ajustes === null) return null;
  if (ajustes === undefined) return <Skeleton className="mt-6 h-40" />;

  return (
    <section
      aria-label="Ajustes de IA del negocio"
      className="mt-6 pulso-panel rounded-tarjeta border border-line bg-raised p-6"
    >
      <span className="rotulo">Proveedor y datos</span>
      <p className="mt-2 max-w-prose text-sm text-body">
        Por defecto tu asistente usa el proveedor que mejor rinde para cada cosa. Si necesitas que
        todo pase por uno solo —porque lo pide tu contrato o porque así lo decidiste— elígelo aquí y
        se respeta en todo, también en lo que agreguemos después.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          Usar solamente
          <Select value={proveedor} onValueChange={setProveedor}>
            <SelectTrigger aria-label="Proveedor único" className="w-64">
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
      {aviso && <AvisoResultado tono="error">{aviso}</AvisoResultado>}
    </section>
  );
}
