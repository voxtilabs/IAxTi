'use client';

import { AvisoResultado, Seccion } from '@iaxti/ui/react';

import { Bot } from 'lucide-react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, useSession } from '@iaxti/ui/react';
import { useSelectedTenant } from './tenant-switcher';
import { apiFetch, avisoDe, type Aviso } from '../lib/api';
import type { Quien } from '@iaxti/sdk';
import { onboardingBusiness } from '@iaxti/sdk';
import { QuienLoHizo } from './quien-lo-hizo';
import { OnboardingCostos } from './onboarding-costos';

// El configurador (#50): "cuéntanos tu negocio y el CRM se arma solo" —
// la propuesta llega como diff ANTES/DESPUÉS (dispositivo Pulso) y el
// usuario la aplica. La IA jamás toca nada sin ese toque.

interface QuienDto {
  agente: { id: string; name: string; model: string } | null;
  propio: boolean;
}

interface PropuestaDto {
  id: string;
  vertical: string;
  status: 'pending' | 'applied' | 'dismissed';
  /**
   * Quién aprobó el diff (#697).
   *
   * `applied_by` se escribía al aplicar y la pantalla no lo mostraba. Aplicar
   * una propuesta cambia la configuración del negocio entero —horarios,
   * plantillas, etapas— y se audita como «user via agent»: quién apretó el
   * botón es la mitad de esa frase.
   */
  aplicadaPor: Quien | null;
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
  const { session } = useSession();
  const tenant = useSelectedTenant();
  return session && tenant ? <ConfiguradorDelNegocio key={`${session.user.id}:${tenant}`} tenant={tenant} /> : null;
}

function ConfiguradorDelNegocio({ tenant }: { tenant: string }) {
  const { session, config } = useSession();
  const [descripcion, setDescripcion] = useState('');
  const [vertical, setVertical] = useState('otro');
  const [propuesta, setPropuesta] = useState<PropuestaDto | null>(null);
  const [quien, setQuien] = useState<QuienDto | null>(null);
  const [pensando, setPensando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [aplicado, setAplicado] = useState<string | null>(null);
  const [decidiendo, setDecidiendo] = useState(false);
  const ocupada = useRef(false);
  const solicitudAccion = useRef<AbortController | null>(null);
  useEffect(() => {
    const controllers = solicitudAccion;
    return () => controllers.current?.abort();
  }, []);
  const editado = useRef(false);
  useEffect(() => {
    if (!session || !tenant) return;
    const controller = new AbortController();
    void onboardingBusiness({ apiUrl: config.apiUrl, token: session.access_token, tenantId: tenant }, controller.signal)
      .then((negocio) => {
        if (controller.signal.aborted || editado.current) return;
        setDescripcion(negocio.description); setVertical(negocio.vertical);
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) setAviso(avisoDe(err));
      });
    return () => controller.abort();
  }, [config.apiUrl, session, tenant]);

  const cargar = useCallback(async (signal: AbortSignal) => {
    if (!session || !tenant) return;
    try {
      const [p, q] = await Promise.all([
        apiFetch<PropuestaDto | null>(config, session, tenant, '/agents/configurador', { signal }),
        apiFetch<QuienDto>(config, session, tenant, '/agents/configurador/quien', { signal }),
      ]);
      if (signal.aborted) return;
      setPropuesta(p);
      setQuien(q);
    } catch (err) {
      if (!signal.aborted) setAviso(avisoDe(err));
    }
  }, [config, session, tenant]);
  useEffect(() => {
    const controller = new AbortController();
    void cargar(controller.signal);
    return () => controller.abort();
  }, [cargar]);

  if (!tenant) return null;

  const proponer = async () => {
    if (!session || ocupada.current) return;
    ocupada.current = true;
    const controller = new AbortController(); solicitudAccion.current = controller;
    setAviso(null);
    setAplicado(null);
    setPensando(true);
    try {
      const p = await apiFetch<PropuestaDto>(config, session, tenant, '/agents/configurador', {
        method: 'POST',
        body: JSON.stringify({ description: descripcion, vertical }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPropuesta(p);
    } catch (err) {
      if (!controller.signal.aborted) setAviso(avisoDe(err));
    } finally {
      ocupada.current = false;
      if (!controller.signal.aborted) setPensando(false);
    }
  };

  const decidir = async (accion: 'aplicar' | 'descartar') => {
    if (!session || !propuesta || ocupada.current) return;
    ocupada.current = true; setDecidiendo(true);
    const controller = new AbortController(); solicitudAccion.current = controller;
    setAviso(null);
    try {
      const res = await apiFetch<{ creado?: { pipeline: boolean; quickReplies: number } }>(
        config, session, tenant,
        `/agents/configurador/${propuesta.id}/${accion}`,
        { method: 'POST', signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setPropuesta(null);
      if (accion === 'aplicar') {
        const c = res.creado;
        setAplicado(
          `Listo: ${c?.pipeline ? 'pipeline creado' : 'pipeline ya estaba'} y ${c?.quickReplies ?? 0} respuestas rápidas nuevas.`,
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) setAviso(avisoDe(err));
    } finally {
      ocupada.current = false;
      if (!controller.signal.aborted) setDecidiendo(false);
    }
  };

  return (
    <Seccion
      rotulo="Arma tu CRM"
      apoyo="Cuéntanos de qué se trata tu negocio. Revisas el antes/después y decides: nada se aplica solo."
    >

      {/* Quién la arma (#415). La propuesta sale con el modelo de ESE
          asistente, y hasta ahora no había forma de saber cuál era. */}
      {quien?.agente && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-body">
          <Bot className="size-3.5 shrink-0" aria-hidden />
          La arma <span className="font-medium text-ink">{quien.agente.name}</span>
          <Badge role="neutral">{quien.agente.model}</Badge>
          {!quien.propio && (
            <span className="text-muted">
              — es el que atiende a tus clientes. Puedes crear uno dedicado a esto en Tu asistente.
            </span>
          )}
        </p>
      )}

      {!propuesta && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm text-body">Rubro</span>
            <Select value={vertical} onValueChange={(value) => { editado.current = true; setVertical(value); }}>
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
            onChange={(e) => { editado.current = true; setDescripcion(e.target.value); }}
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
          {propuesta.status === 'applied' && (
            <p className="mb-3"><QuienLoHizo accion="Aplicada" quien={propuesta.aplicadaPor} /></p>
          )}
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
            <Button disabled={decidiendo} onClick={() => void decidir('aplicar')} data-testid="configurador-aplicar">
              {decidiendo ? 'Guardando…' : 'Aplicar lo nuevo'}
            </Button>
            <Button disabled={decidiendo} variant="secundario" onClick={() => void decidir('descartar')}>
              Descartar
            </Button>
          </div>
        </div>
      )}

      {aplicado && <AvisoResultado tono="success">{aplicado}</AvisoResultado>}
      {(aplicado || propuesta?.status === 'applied') && <div className="mt-4"><OnboardingCostos tenant={tenant} /></div>}
      {aviso && (
        <AvisoResultado>
          {aviso.texto}{aviso.rastro && <span className="dato block break-all text-xs">{aviso.rastro}</span>}
        </AvisoResultado>
      )}
    </Seccion>
  );
}
