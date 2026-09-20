'use client';

import { AvisoResultado } from '@iaxti/ui/react';

import { Bot } from 'lucide-react';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, useSession } from '@iaxti/ui/react';
import { selectedTenant } from './tenant-switcher';
import { apiFetch } from '../lib/api';

// El configurador (#50): "cuéntanos tu negocio y el CRM se arma solo" —
// la propuesta llega como diff ANTES/DESPUÉS (dispositivo Pulso) y el
// usuario la aplica. La IA jamás toca nada sin ese toque.

interface PropuestaDto {
  id: string;
  vertical: string;
  status: 'pending' | 'applied' | 'dismissed';
  diff: {
    antes: { pipelines: string[]; quickReplies: string[] };
    items: Array<{ tipo: string; nombre: string; detalle: string; accion: 'crear' | 'ya_existe' | 'proponer' }>;
    nota: string | null;
  };
}

const VERTICALES = [
  { value: 'belleza', label: 'Belleza y estética' },
  { value: 'salud', label: 'Salud' },
  { value: 'inmobiliaria', label: 'Inmobiliaria' },
  { value: 'retail', label: 'Tienda / retail' },
  { value: 'servicios', label: 'Servicios profesionales' },
  { value: 'otro', label: 'Otro' },
];

const TIPO_LABEL: Record<string, string> = {
  pipeline: 'Pipeline',
  quick_reply: 'Respuesta rápida',
  wa_template: 'Plantilla de WhatsApp',
};

export function Configurador() {
  const { session, config } = useSession();
  const [tenant, setTenant] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState('');
  const [vertical, setVertical] = useState('otro');
  const [propuesta, setPropuesta] = useState<PropuestaDto | null>(null);
  const [pensando, setPensando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [aplicado, setAplicado] = useState<string | null>(null);

  useEffect(() => setTenant(selectedTenant()), []);
  const cargar = useCallback(async () => {
    if (!session || !tenant) return;
    try {
      setPropuesta(await apiFetch<PropuestaDto | null>(config, session, tenant, '/agents/configurador'));
    } catch {
      /* sin permiso agents.configure: la sección simplemente no opera */
    }
  }, [config, session, tenant]);
  useEffect(() => void cargar(), [cargar]);

  if (!tenant) return null;

  const proponer = async () => {
    if (!session) return;
    setAviso(null);
    setAplicado(null);
    setPensando(true);
    try {
      const p = await apiFetch<PropuestaDto>(config, session, tenant, '/agents/configurador', {
        method: 'POST',
        body: JSON.stringify({ description: descripcion, vertical }),
      });
      setPropuesta(p);
    } catch (err) {
      setAviso((err as Error).message);
    } finally {
      setPensando(false);
    }
  };

  const decidir = async (accion: 'aplicar' | 'descartar') => {
    if (!session || !propuesta) return;
    setAviso(null);
    try {
      const res = await apiFetch<{ creado?: { pipeline: boolean; quickReplies: number } }>(
        config, session, tenant,
        `/agents/configurador/${propuesta.id}/${accion}`,
        { method: 'POST' },
      );
      setPropuesta(null);
      if (accion === 'aplicar') {
        const c = res.creado;
        setAplicado(
          `Listo: ${c?.pipeline ? 'pipeline creado' : 'pipeline ya estaba'} y ${c?.quickReplies ?? 0} respuestas rápidas nuevas.`,
        );
      }
    } catch (err) {
      setAviso((err as Error).message);
    }
  };

  return (
    <div className="mt-4 max-w-xl rounded-tarjeta border border-line bg-raised p-6">
      <span className="rotulo">Arma tu CRM</span>
      <p className="mt-2 text-sm text-muted">
        Cuéntanos de qué se trata tu negocio y el asistente propone el pipeline, las respuestas
        rápidas y las plantillas de WhatsApp. Tú revisas el antes/después y decides — nada se
        aplica solo.
      </p>

      {!propuesta && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm text-body">Rubro</span>
            <Select value={vertical} onValueChange={setVertical}>
              <SelectTrigger aria-label="Rubro" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERTICALES.map((v) => (
                  <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            aria-label="Descripción del negocio"
            className="mt-3"
            rows={3}
            placeholder="Ej: Somos una barbería en Ñuñoa, 3 barberos, atendemos con y sin reserva…"
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
          />
          <Button
            className="mt-3"
            disabled={pensando || descripcion.trim().length < 10}
            onClick={() => void proponer()}
            data-testid="configurador-proponer"
          >
            {pensando ? 'Armando la propuesta…' : 'Proponer configuración'}
          </Button>
        </>
      )}

      {propuesta && (
        <div className="mt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-campo border border-line bg-bg p-4">
              <p className="rotulo">Cómo trabajas hoy</p>
              {propuesta.diff.antes.pipelines.length === 0 && propuesta.diff.antes.quickReplies.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Todo a mano: sin pipeline, sin atajos.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-sm text-body">
                  {propuesta.diff.antes.pipelines.map((p) => <li key={p}>{p}</li>)}
                  {propuesta.diff.antes.quickReplies.map((q) => <li key={q} className="dato">{q}</li>)}
                </ul>
              )}
            </div>
            <div className="rounded-campo border border-action-soft-br bg-action-soft p-4">
              <p className="rotulo">Con IAxTi</p>
              <ul className="mt-2 flex flex-col gap-2">
                {propuesta.diff.items.map((item) => (
                  <li key={`${item.tipo}-${item.nombre}`} className="text-sm">
                    <span className="flex items-center gap-2">
                      <Badge role={item.accion === 'crear' ? 'good' : item.accion === 'proponer' ? 'action' : 'neutral'}>
                        {item.accion === 'crear' ? 'Nuevo' : item.accion === 'proponer' ? 'Para aprobar' : 'Ya lo tienes'}
                      </Badge>
                      <span className="font-bold text-ink">{TIPO_LABEL[item.tipo] ?? item.tipo}: {item.nombre}</span>
                    </span>
                    <span className="mt-0.5 block text-muted">{item.detalle}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {propuesta.diff.nota && <p className="mt-3 flex items-start gap-1.5 text-sm text-body">
              <Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {propuesta.diff.nota}
            </p>}
          <p className="mt-2 text-sm text-muted">
            Las plantillas de WhatsApp quedan propuestas: se envían a aprobación de Meta cuando el
            canal esté conectado.
          </p>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void decidir('aplicar')} data-testid="configurador-aplicar">
              Aplicar lo nuevo
            </Button>
            <Button variant="secundario" onClick={() => void decidir('descartar')}>
              Descartar
            </Button>
          </div>
        </div>
      )}

      {aplicado && <AvisoResultado tono="success">{aplicado}</AvisoResultado>}
      {aviso && (
        <AvisoResultado>
          {aviso}
        </AvisoResultado>
      )}
    </div>
  );
}
