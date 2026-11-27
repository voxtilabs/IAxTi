import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { publishEvent } from '@iaxti/core';
import { getTenantSettings, incrementUsage } from '@iaxti/module-organizations';
import { DEFAULT_TASK_OUTPUT_TOKENS, estimateCostUsd, iaSettings } from '../domain/config';
import {
  chatsParaLeer,
  leerLoAprendido,
  pedidoDeAprendizaje,
  type ChatParaAprender,
  type LoAprendido,
} from '../domain/aprender-de-chats';
import { esDelProveedor } from './fallo-del-proveedor';
import { castigar, estaCastigado, perdonar } from './castigados';
import { motivoDelProveedor } from './motivo-del-proveedor';
import { traceGeneration } from './langfuse';
import { aiSdkModelPort, providerAvailable, type ModelPortFactory } from './models';
import { afterExecutionQuota, getQuota } from './quota';
import { semillaCacheada } from './defecto-de-la-plataforma';

/**
 * Aprender de los chats del negocio, POR EL CAMINO DE LA IA DE SIEMPRE
 * (#1406, ADR-0039).
 *
 * Es el mismo camino que `runAgentTask` — mismo proveedor por tarea según la
 * configuración del negocio, misma cuota con su modelo económico, misma fila
 * en `agent_executions`, mismo `incrementUsage`, mismos eventos y la misma
 * traza — con DOS diferencias que son el ADR entero:
 *
 * 1. **El pedido lo arma el dominio, no este archivo.** El sistema y el
 *    prompt son los que salen de `aprender-de-chats.ts`: los chats ya
 *    redactados. Acá no se compone ni una frase; si se compusiera, la
 *    redacción tendría una segunda copia, y la copia que se queda atrás es
 *    la que deja pasar un teléfono.
 * 2. **Lo que ENTRA no se guarda.** `agent_executions.input` guarda la
 *    forma de la corrida (cuántos chats, que venían redactados) y jamás los
 *    chats: ADR-0039 los descarta en memoria. Lo que SÍ se guarda es la
 *    salida —lo aprendido— porque es lo extraído, lo único que el ADR deja
 *    quedar, y es lo que la dueña va a revisar en la fuente `por_revisar`.
 */

export type ResultadoDelAprendizaje =
  | {
      status: 'ok';
      tono: string | null;
      entradas: LoAprendido['entradas'];
      executionId: string;
      degraded: boolean;
      provider: string;
      model: string;
      costUsd: number | null;
      tokensIn: number;
      tokensOut: number;
    }
  | { status: 'failed'; error: string; executionId: string | null; provider: string; model: string }
  /** No había líneas que leer: no se llama al proveedor ni se paga nada. */
  | { status: 'sin_chats' };

/**
 * La corrida completa: recibe los chats tal como los entrega el canal, los
 * pasa por el dominio, llama al proveedor del NEGOCIO y devuelve lo aprendido
 * ya validado y vuelto a redactar.
 *
 * El fallo se DEVUELVE y no se lanza, igual que `runAgentTask`: la corrida
 * fallida y su evento viven en la misma transacción, y un `throw` los
 * revertiría.
 */
export async function aprenderDeLosChats(
  client: PoolClient,
  input: { tenantId: string; chats: ChatParaAprender[]; requestId?: string; actorUserId?: string },
  modelPortFactory: ModelPortFactory = aiSdkModelPort,
): Promise<ResultadoDelAprendizaje> {
  const lineas = chatsParaLeer(input.chats);
  if (lineas.length === 0) return { status: 'sin_chats' };
  const pedido = pedidoDeAprendizaje(lineas);

  // El proveedor del NEGOCIO por tarea, con sus respaldos y castigos: la
  // misma resolución que hace cada corrida del asistente.
  const settings = iaSettings(
    await getTenantSettings(client, input.tenantId),
    providerAvailable,
    estaCastigado,
    await semillaCacheada(client),
  );
  const porTarea = settings.tasks.aprender;
  let provider = porTarea.provider;
  let model = porTarea.model;
  let esfuerzo = porTarea.esfuerzo;

  // La cuota (#52), con la misma regla que el asistente: al 100 % sigue con
  // el modelo económico si el negocio lo configuró; sin él, no se llama al
  // proveedor y el motivo queda escrito.
  const quota = await getQuota(client, input.tenantId);
  let degraded = false;
  if (quota.exhausted) {
    if (settings.economico) {
      provider = settings.economico.provider;
      model = settings.economico.model;
      esfuerzo = settings.economico.esfuerzo ?? esfuerzo;
      degraded = true;
    } else {
      const rechazo =
        'La cuota de IA del mes está completa. Sube de plan o configura un modelo económico para seguir.';
      const fila = await client.query(
        `INSERT INTO agent_executions
           (tenant_id, task, provider, model, input, latency_ms, trace_id, status, error, explanation)
         VALUES ($1,'aprender',$2,$3,$4,0,$5,'failed',$6,$7) RETURNING id`,
        [
          input.tenantId,
          provider,
          model,
          // Sin chats, nunca: la forma de la corrida y nada más.
          JSON.stringify({ chats: lineas.length, redactado: true }),
          input.requestId ?? randomUUID(),
          rechazo,
          'Aprender de los chats rechazado por cuota.',
        ],
      );
      return { status: 'failed', error: rechazo, executionId: fila.rows[0].id, provider, model };
    }
  }

  const traceId = input.requestId ?? randomUUID();
  const inicio = Date.now();
  try {
    const res = await modelPortFactory(provider, model).generate({
      system: pedido.system,
      prompt: pedido.prompt,
      maxOutputTokens: DEFAULT_TASK_OUTPUT_TOKENS.aprender,
      ...(esfuerzo ? { esfuerzo } : {}),
    });
    const latencyMs = Date.now() - inicio;
    const costUsd = estimateCostUsd(provider, model, res.tokensIn, res.tokensOut);
    // Se lee UNA vez, y desde acá en adelante solo existe lo leído y redactado.
    const aprendido = leerLoAprendido(res.text);
    const fila = await client.query(
      `INSERT INTO agent_executions
         (tenant_id, task, provider, model, input, output, tokens_in, tokens_out, cost_usd,
          latency_ms, trace_id, explanation)
       VALUES ($1,'aprender',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        input.tenantId,
        provider,
        model,
        // La ENTRADA de esta corrida es la única excepción del acta: los
        // chats no se guardan (ADR-0039). Lo que va es la forma —cuántos
        // chats, que ya venían redactados—, que es lo único que explica la
        // salida sin copiar lo que no debe quedar.
        JSON.stringify({ chats: lineas.length, redactado: true }),
        // La salida YA LEÍDA y redactada otra vez (`leerLoAprendido`), nunca
        // el texto crudo del modelo: si copió un dato de un cliente, la
        // segunda redacción lo limpia, y la copia cruda no puede quedarse acá.
        JSON.stringify({ ...aprendido, ...(res.truncada ? { truncada: true } : {}) }),
        res.tokensIn,
        res.tokensOut,
        costUsd,
        latencyMs,
        traceId,
        `Aprender de ${lineas.length} chats con ${provider}/${model} en ${latencyMs} ms.` +
          (degraded ? ' (cuota al 100 %: modelo económico)' : '') +
          (res.truncada ? ' La respuesta vino cortada por el tope.' : ''),
      ],
    );
    await incrementUsage(client, input.tenantId, 'ia_executions');
    await afterExecutionQuota(client, input.tenantId, traceId);
    await publishEvent(client, {
      name: 'agent.executed',
      tenantId: input.tenantId,
      payload: { executionId: fila.rows[0].id, task: 'aprender', provider, model, costUsd },
      actor: input.actorUserId ?? 'system',
      requestId: traceId,
    });
    // A Langfuse va la FORMA, no el contenido (ADR-0039): aunque los chats ya
    // salen redactados, mandarlos a un servicio de trazas es guardarlos en
    // otro lado, y el ADR dice que se leen en memoria y se descartan.
    traceGeneration({
      traceId,
      tenantId: input.tenantId,
      task: 'aprender',
      provider,
      model,
      input: JSON.stringify({ chats: lineas.length, redactado: true }),
      output: JSON.stringify({ entradas: aprendido.entradas.length, tono: aprendido.tono !== null }),
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs,
    });
    perdonar(provider);
    return {
      status: 'ok',
      ...aprendido,
      executionId: fila.rows[0].id,
      degraded,
      provider,
      model,
      costUsd,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
    };
  } catch (err) {
    const latencyMs = Date.now() - inicio;
    const delProveedor = esDelProveedor(err);
    castigar(provider, motivoDelProveedor(err, { provider, model, delProveedor }).motivo);
    const fila = await client.query(
      `INSERT INTO agent_executions
         (tenant_id, task, provider, model, input, latency_ms, trace_id, status, error, explanation, error_del_proveedor)
       VALUES ($1,'aprender',$2,$3,$4,$5,$6,'failed',$7,$8,$9) RETURNING id`,
      [
        input.tenantId,
        provider,
        model,
        JSON.stringify({ chats: lineas.length, redactado: true }),
        latencyMs,
        traceId,
        (err as Error).message,
        delProveedor
          ? 'Aprender de los chats falló: el error vino del proveedor.'
          : 'Aprender de los chats falló, y el error NO fue del proveedor.',
        delProveedor,
      ],
    );
    await publishEvent(client, {
      name: 'agent.failed',
      tenantId: input.tenantId,
      payload: { task: 'aprender', provider, model, error: (err as Error).message, delProveedor },
      actor: 'system',
      requestId: traceId,
    });
    return {
      status: 'failed',
      error: (err as Error).message,
      executionId: fila.rows[0].id,
      provider,
      model,
    };
  }
}
