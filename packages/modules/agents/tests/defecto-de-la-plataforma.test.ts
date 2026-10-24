import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool, runMigrations } from '@iaxti/db';
import { DEFAULT_TASK_MODELS } from '../domain/config';
import {
  ProveedorSinFilaDeCompliance,
  TareaQueElProveedorNoAtiende,
  defectosDeLaPlataforma,
  fijarDefectoDeLaTarea,
  semillaEfectiva,
} from '../application/defecto-de-la-plataforma';

/**
 * El defecto de IA de la plataforma, fuera del código (#858).
 *
 * Vivía en `DEFAULT_TASK_MODELS`. Moverlo —como el 12-10, cuando pasó de GLM a
 * OpenAI— era editar un `.ts`, abrir un PR y esperar un despliegue: media hora
 * de CI para la decisión más caliente del producto, justo el día en que un
 * proveedor se cae o se queda sin saldo.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
let admin: Pool;
let client: PoolClient;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await runMigrations(admin);
  client = await admin.connect();
});

afterAll(async () => {
  client.release();
  await admin.end();
});

beforeEach(async () => {
  await client.query('DELETE FROM agent_task_defaults');
});

/** El rastro lo escribe quien llama: acá se mira que lo pida y con qué. */
const auditor = () => vi.fn(async () => {});

describe('el defecto de la plataforma (#858)', () => {
  it('sin filas, devuelve la semilla del código y lo dice', async () => {
    const todos = await defectosDeLaPlataforma(client);
    expect(todos.sugerir.provider).toBe(DEFAULT_TASK_MODELS.sugerir.provider);
    expect(todos.sugerir.model).toBe(DEFAULT_TASK_MODELS.sugerir.model);
    // `desdeLaBase` es lo que distingue «el repo decidió esto» de «alguien lo
    // cambió»: sin eso, el panel no puede decir si lo que muestra es una
    // decisión tomada o el valor con el que vino el despliegue.
    expect(todos.sugerir.desdeLaBase).toBe(false);
    expect(todos.sugerir.cambiadoPor).toBeNull();
  });

  it('cambiarlo lo guarda, lo devuelve y pide el rastro con el antes y el después', async () => {
    const auditar = auditor();
    await fijarDefectoDeLaTarea(client, {
      task: 'sugerir',
      provider: 'openai',
      model: 'gpt-5',
      esfuerzo: 'medio',
      actor: 'admin-1',
      auditar,
    });

    const todos = await defectosDeLaPlataforma(client);
    expect(todos.sugerir).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      esfuerzo: 'medio',
      desdeLaBase: true,
      cambiadoPor: 'admin-1',
    });

    expect(auditar).toHaveBeenCalledTimes(1);
    const [, cambio] = auditar.mock.calls[0] as unknown as [PoolClient, Record<string, unknown>];
    expect(cambio).toMatchObject({
      tarea: 'sugerir',
      antes: { provider: DEFAULT_TASK_MODELS.sugerir.provider, model: DEFAULT_TASK_MODELS.sugerir.model },
      despues: { provider: 'openai', model: 'gpt-5', esfuerzo: 'medio' },
      // Quien lea el libro necesita saber que el «antes» no estaba guardado
      // en ninguna parte: era el del código.
      veniaDelCodigo: true,
    });
  });

  it('el rastro va en la MISMA transacción: si falla, no hay cambio', async () => {
    const auditar = vi.fn(async () => {
      throw new Error('el libro no acepta');
    });
    await client.query('BEGIN');
    await expect(
      fijarDefectoDeLaTarea(client, {
        task: 'resumir',
        provider: 'openai',
        model: 'gpt-5-mini',
        actor: 'admin-1',
        auditar,
      }),
    ).rejects.toThrow('el libro no acepta');
    await client.query('ROLLBACK');

    // Y el cambio no quedó. Esto es lo que hace que el rastro sea obligatorio
    // de verdad y no una promesa del comentario.
    expect((await defectosDeLaPlataforma(client)).resumir.desdeLaBase).toBe(false);
  });

  it('un proveedor sin fila de compliance NO se puede fijar', async () => {
    // `anthropic` es elegible por un tenant y su fila no lo declara defecto.
    // Esto decide hacia qué empresa sale el texto de TODOS los negocios, así
    // que la matriz se escribe primero y el switch se mueve después.
    const auditar = auditor();
    await expect(
      fijarDefectoDeLaTarea(client, {
        task: 'resumir',
        provider: 'anthropic',
        model: 'claude-x',
        actor: 'admin-1',
        auditar,
      }),
    ).rejects.toBeInstanceOf(ProveedorSinFilaDeCompliance);
    expect(auditar).not.toHaveBeenCalled();
    expect((await defectosDeLaPlataforma(client)).resumir.desdeLaBase).toBe(false);
  });

  it('un proveedor que no atiende esa tarea tampoco, y el motivo es otro', async () => {
    // Desde #864 OpenAI SÍ transcribe (por su API de audio); el que sigue sin
    // poder es GLM — cero ASR en su catálogo (rev. 25-09). No es política: es
    // capacidad, y el error lo dice distinto para que nadie lo lea como una
    // decisión de compliance.
    await expect(
      fijarDefectoDeLaTarea(client, {
        task: 'transcribir',
        provider: 'glm',
        model: 'glm-4.6',
        actor: 'admin-1',
        auditar: auditor(),
      }),
    ).rejects.toBeInstanceOf(TareaQueElProveedorNoAtiende);
  });

  it('una fila con un proveedor que ya no existe se ignora y vuelve la semilla', async () => {
    // Pasa al retirar un proveedor del producto: la fila queda apuntando a un
    // adaptador que no está. Servir con eso sería un 404 por cada llamada, en
    // silencio; volver a la semilla al menos atiende.
    await client.query(
      `INSERT INTO agent_task_defaults (task, provider, model) VALUES ('conocer', 'retirado', 'x')`,
    );
    const todos = await defectosDeLaPlataforma(client);
    expect(todos.conocer.provider).toBe(DEFAULT_TASK_MODELS.conocer.provider);
    expect(todos.conocer.desdeLaBase).toBe(false);
  });

  it('`semillaEfectiva` devuelve las nueve tareas, en la forma que espera iaSettings', async () => {
    await fijarDefectoDeLaTarea(client, {
      task: 'clasificar',
      provider: 'openai',
      model: 'gpt-5-nano',
      esfuerzo: 'minimo',
      actor: 'admin-1',
      auditar: auditor(),
    });
    const semilla = await semillaEfectiva(client);
    expect(Object.keys(semilla)).toHaveLength(Object.keys(DEFAULT_TASK_MODELS).length);
    expect(semilla.clasificar).toEqual({ provider: 'openai', model: 'gpt-5-nano', esfuerzo: 'minimo' });
    // Y sin los campos del panel: `iaSettings` no sabe de quién lo cambió.
    expect(semilla.clasificar).not.toHaveProperty('desdeLaBase');
  });
});
