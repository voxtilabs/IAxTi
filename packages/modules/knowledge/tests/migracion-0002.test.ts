import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '@iaxti/db';

// #502: que la migración funcione en una base vacía no prueba nada — el
// problema es la base que YA tiene conocimiento indexado con el modelo viejo.
// Acá se arma la forma vieja a mano (vector(768) con filas, su índice HNSW,
// fuentes activas y cache caliente), se corre el SQL de verdad —el archivo,
// no una copia— y se revisa qué quedó.
//
// Va en un esquema aparte y no en otra base: el SQL nombra las tablas sin
// esquema, así que basta ponerlo primero en el search_path.

const ADMIN_URL =
  process.env.DATABASE_URL ?? 'postgres://iaxti:iaxti@127.0.0.1:5432/iaxti';
const SQL = readFileSync(
  join(__dirname, '..', 'migrations', '0002_embeddings_2048.sql'),
  'utf8',
);

let admin: Pool;

beforeAll(async () => {
  admin = createPool(ADMIN_URL);
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query('DROP SCHEMA IF EXISTS antes_de_0002 CASCADE');
  await admin.query('CREATE SCHEMA antes_de_0002');
});

afterAll(async () => {
  await admin.query('DROP SCHEMA IF EXISTS antes_de_0002 CASCADE');
  await admin.end();
});

type Consulta = (sql: string, p?: unknown[]) => Promise<QueryResult<Record<string, unknown>>>;

async function enElEsquemaViejo<T>(fn: (q: Consulta) => Promise<T>) {
  const c = await admin.connect();
  try {
    await c.query('SET search_path TO antes_de_0002, public');
    return await fn((sql, p) => c.query(sql, p as unknown[]));
  } finally {
    c.release();
  }
}

describe('migración 0002 sobre una base que ya tenía conocimiento (#502)', () => {
  it('cambia la columna, rehace el índice y deja todo por reindexar', async () => {
    await enElEsquemaViejo(async (q) => {
      // La forma vieja, tal como quedó después de 0001.
      await q(`CREATE TABLE sources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        kind text NOT NULL,
        name text NOT NULL,
        content text,
        status text NOT NULL DEFAULT 'processing',
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await q(`CREATE TABLE chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        source_id uuid NOT NULL,
        content text NOT NULL,
        question text,
        embedding vector(768),
        position int NOT NULL DEFAULT 0
      )`);
      await q('CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)');
      await q(`CREATE TABLE knowledge_query_cache (
        tenant_id uuid NOT NULL, query_hash text NOT NULL, results jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

      const tenant = '11111111-1111-1111-1111-111111111111';
      const f = await q(
        `INSERT INTO sources (tenant_id, kind, name, content, status)
         VALUES ($1,'texto','Precios','Corte 12000','active') RETURNING id`,
        [tenant],
      );
      const rota = await q(
        `INSERT INTO sources (tenant_id, kind, name, content, status, error)
         VALUES ($1,'url','Web caída',NULL,'failed','timeout') RETURNING id`,
        [tenant],
      );
      // Una vencida: no se toca, porque vencida es una decisión del negocio y
      // no un problema de indexación.
      await q(
        `INSERT INTO sources (tenant_id, kind, name, content, status)
         VALUES ($1,'texto','Promo de agosto','2x1','expired')`,
        [tenant],
      );
      const viejo = `[${new Array(768).fill(0.1).join(',')}]`;
      await q(
        `INSERT INTO chunks (tenant_id, source_id, content, embedding) VALUES ($1,$2,'Corte 12000',$3::vector)`,
        [tenant, f.rows[0].id, viejo],
      );
      await q(`INSERT INTO knowledge_query_cache (tenant_id, query_hash, results) VALUES ($1,'abc','[]'::jsonb)`, [tenant]);

      // Y ahora la migración de verdad.
      await q(SQL);

      const tipo = await q(
        `SELECT format_type(a.atttypid, a.atttypmod) AS t
           FROM pg_attribute a
          WHERE a.attrelid = 'antes_de_0002.chunks'::regclass AND a.attname = 'embedding'`,
      );
      expect(tipo.rows[0].t).toBe('halfvec(2048)');

      // El índice tiene que EXISTIR: sin él la búsqueda recorre la tabla
      // entera y el conocimiento se pone lento justo cuando crece.
      const idx = await q(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'antes_de_0002' AND indexname = 'chunks_embedding_idx'`,
      );
      expect(idx.rowCount).toBe(1);
      expect(idx.rows[0].indexdef).toContain('halfvec_cosine_ops');

      // Y tiene que aceptar un vector nuevo: es la comprobación de que 2048
      // entra, que era justo lo que el HNSW sobre `vector` no permitía.
      await q(
        `INSERT INTO chunks (tenant_id, source_id, content, embedding)
         VALUES ($1,$2,'nuevo',$3::halfvec)`,
        [tenant, f.rows[0].id, `[${new Array(2048).fill(0.02).join(',')}]`],
      );

      const cache = await q('SELECT count(*)::int AS n FROM knowledge_query_cache');
      expect(cache.rows[0].n, 'el cache viejo contesta con el buscador de ayer').toBe(0);

      const estados = await q('SELECT name, status FROM sources ORDER BY name');
      expect(Object.fromEntries(estados.rows.map((r) => [r.name, r.status]))).toEqual({
        Precios: 'processing',
        'Promo de agosto': 'expired',
        'Web caída': 'processing',
      });
      const errores = await q(`SELECT count(*)::int AS n FROM sources WHERE error IS NOT NULL`);
      expect(errores.rows[0].n, 'el error viejo ya no aplica: se reintenta limpio').toBe(0);

      expect(rota.rowCount).toBe(1);
    });
  }, 60_000);

  it('correrla dos veces no rompe nada', async () => {
    // Un despliegue reintentado no puede dejar la base a medio migrar.
    await enElEsquemaViejo(async (q) => {
      await q(SQL);
      const tipo = await q(
        `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
          WHERE a.attrelid = 'antes_de_0002.chunks'::regclass AND a.attname = 'embedding'`,
      );
      expect(tipo.rows[0].t).toBe('halfvec(2048)');
    });
  }, 60_000);
});
