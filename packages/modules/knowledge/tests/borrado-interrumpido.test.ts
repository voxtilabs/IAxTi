import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createPool, runMigrations, withTenant } from '@iaxti/db';
import { consultarR2, type ConsultaObjetos } from '@iaxti/core';
import { addSource, eliminarFuente, processSource } from '../application/sources';
import { reconciliarBorradosPendientes } from '../application/file-deletions';
import { searchKnowledge, getProduct } from '../application/search';
import { DIMENSIONES, type EmbedPort } from '../application/embeddings';

// PostgreSQL y RLS reales. R2 se sustituye explícitamente por un almacén en
// memoria/HTTP simulado: estas pruebas no dicen haber contactado Cloudflare.
let owner: Pool;
let app: Pool;
let tenant: string;
const tenants: string[] = [];
const role = `test_knowledge_751_${randomUUID().replaceAll('-', '')}`;
const vector = Array.from({ length: DIMENSIONES }, (_, i) => i === 0 ? 1 : 0);
const embed: EmbedPort = { async embed(texts) { return texts.map(() => vector); } };
const pending = async (id: string) => (await owner.query('SELECT * FROM pending_file_deletions WHERE source_id=$1', [id])).rows;
const status = async (id: string) => (await owner.query('SELECT status FROM sources WHERE id=$1', [id])).rows[0]?.status;
const aged = async (id: string, key: string, confirmed = false) => owner.query(
  `INSERT INTO pending_file_deletions(tenant_id,source_id,r2_key,created_at,confirmed_at)
   VALUES($1,$2,$3,now()-interval '10 minutes',CASE WHEN $4 THEN now() ELSE NULL END)`,
  [tenant, id, key, confirmed],
);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function source(name: string, key = `${tenant}/conocimiento/${randomUUID()}.pdf`) {
  const f = await withTenant(app, tenant, c => addSource(c, { tenantId: tenant, kind: 'pdf', name, r2Key: key }));
  await owner.query("UPDATE sources SET status='active' WHERE id=$1", [f.id]);
  return { id: f.id, key };
}
const input = (id: string, borrar: (keys: string[]) => Promise<{ borradas: string[]; fallidas: string[] }>) => ({
  tenantId: tenant, sourceId: id, actor: 'test', almacen: { borrar },
});

// Inyecta fallo DESPUÉS del efecto externo y conserva la intención confirmada.
// No mata un proceso: deja exactamente el estado de su rollback, y lo declara.
function commitMuerto(real: Pool): Pool {
  let deleting = false;
  return new Proxy(real, { get(target, prop) {
    if (prop !== 'connect') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
    return async () => {
      const c = await real.connect();
      return new Proxy(c, { get(client, key) {
        if (key !== 'query') { const value = Reflect.get(client, key); return typeof value === 'function' ? value.bind(client) : value; }
        return (sql: string, values?: unknown[]) => {
          if (sql.startsWith('DELETE FROM sources')) deleting = true;
          if (sql === 'COMMIT' && deleting) return Promise.reject(new Error('crash simulado antes de COMMIT'));
          return client.query(sql, values);
        };
      } }) as PoolClient;
    };
  } });
}

beforeAll(async () => {
  owner = createPool();
  await runMigrations(owner);
  await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'fixture-751' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT EXECUTE ON FUNCTION tenants_con_borrados_de_conocimiento(timestamptz) TO ${role}`);
  const url = new URL(process.env.DATABASE_URL!); url.username = role; url.password = 'fixture-751';
  // Una sola conexión prueba que no se pide otra mientras se retiene una TX.
  app = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 1000 });
});
beforeEach(async () => {
  tenant = (await owner.query("INSERT INTO tenants(name) VALUES('reconciliación-751') RETURNING id")).rows[0].id;
  tenants.push(tenant);
});
afterEach(async () => { await owner.query('DELETE FROM pending_file_deletions WHERE tenant_id=$1', [tenant]); });
afterAll(async () => {
  await app.end();
  await owner.query('DELETE FROM pending_file_deletions WHERE tenant_id=ANY($1::uuid[])', [tenants]);
  await owner.query(`DROP OWNED BY ${role}`);
  await owner.query(`DROP ROLE ${role}`);
  await owner.end();
});

describe('intención durable y barrido observador (#751)', () => {
  it('estado exacto tras crash: active, archivo ausente, índice y cache vivos; luego no citable', async () => {
    const f = await source('precios');
    await owner.query(`INSERT INTO chunks(tenant_id,source_id,content,embedding) VALUES($1,$2,'manicure cuesta 15000',$3::halfvec)`, [tenant, f.id, `[${vector.join(',')}]`]);
    await owner.query(`INSERT INTO products(tenant_id,source_id,name,price) VALUES($1,$2,'Manicure',15000)`, [tenant, f.id]);
    const pregunta = `manicure ${f.id}`;
    expect((await withTenant(app, tenant, c => searchKnowledge(c, { tenantId: tenant, query: pregunta }, embed))).hits.some(h => h.sourceId === f.id)).toBe(true);
    const files = new Set([f.key]);
    await expect(eliminarFuente(commitMuerto(app), input(f.id, async keys => {
      // Otra conexión ve la intención ANTES de ejecutar el efecto irreversible.
      expect(await pending(f.id)).toHaveLength(1);
      keys.forEach(k => files.delete(k));
      return { borradas: keys, fallidas: [] };
    }))).rejects.toThrow('crash simulado');
    expect(files.has(f.key)).toBe(false);
    expect(await status(f.id)).toBe('active');
    expect((await pending(f.id))[0].confirmed_at).toBeNull();
    await owner.query("UPDATE pending_file_deletions SET created_at=now()-interval '10 minutes' WHERE source_id=$1", [f.id]);
    const methods: string[] = [];
    const consulta = consultarR2({ endpoint: 'https://storage.test', bucket: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture' }, (async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response(null, { status: 404 });
    }) as typeof fetch)!;
    const result = await reconciliarBorradosPendientes(app, consulta);
    expect(result.marcadas).toBeGreaterThanOrEqual(1);
    expect(await status(f.id)).toBe('delete_failed');
    expect(await pending(f.id)).toEqual([]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(['HEAD'])); // nunca DELETE, puerto real de producción
    const after = await withTenant(app, tenant, c => searchKnowledge(c, { tenantId: tenant, query: pregunta }, embed));
    expect(after.hits.some(h => h.sourceId === f.id)).toBe(false);
    expect(after.cached).toBe(false);
    expect(await withTenant(app, tenant, c => getProduct(c, tenant, 'manicure'))).toEqual([]);
    await reconciliarBorradosPendientes(app, consulta);
    expect((await owner.query("SELECT 1 FROM audit_log WHERE resource_id=$1 AND action='knowledge.source.sin_archivo'", [f.id])).rowCount).toBe(1);
  });

  it.each(['active', 'expired', 'delete_failed'])('HEAD presente limpia intención y conserva %s sin revivir', async state => {
    const f = await source(state);
    await owner.query('UPDATE sources SET status=$2 WHERE id=$1', [f.id, state]);
    await aged(f.id, f.key);
    const calls: string[] = [];
    await reconciliarBorradosPendientes(app, { async estado(key) { calls.push(key); return 'presente'; } });
    expect(calls).toContain(f.key);
    expect(await pending(f.id)).toEqual([]);
    expect(await status(f.id)).toBe(state);
  });

  it('HEAD desconocido o que lanza conserva pendiente y continúa con el siguiente', async () => {
    const bad = await source('timeout'); const ok = await source('ausente');
    await aged(bad.id, bad.key); await aged(ok.id, ok.key);
    const consulta: ConsultaObjetos = { async estado(key) { if (key === bad.key) throw new Error('timeout'); return 'ausente'; } };
    const result = await reconciliarBorradosPendientes(app, consulta);
    expect(result.desconocidas).toBeGreaterThanOrEqual(1);
    expect(await status(bad.id)).toBe('active');
    expect(await pending(bad.id)).toHaveLength(1);
    expect(await status(ok.id)).toBe('delete_failed');
  });

  it('el barrido salta DELETE lento aunque sea antiguo, luego repara su rollback exacto', async () => {
    const f = await source('lento'); const started = gate(); const finish = gate();
    const deletion = eliminarFuente(commitMuerto(app), input(f.id, async keys => {
      started.resolve(); await finish.promise;
      return { borradas: keys, fallidas: [] };
    }));
    // Se observa desde OTRO pool: el pool de la API deliberadamente tiene max=1.
    const rejected = expect(deletion).rejects.toThrow('crash simulado');
    await started.promise;
    const calls: string[] = [];
    const consulta: ConsultaObjetos = { async estado(key) { calls.push(key); return 'ausente'; } };
    try {
      await reconciliarBorradosPendientes(owner, consulta, { now: new Date(Date.now() + 600_000) });
      // El claim SKIP LOCKED omite la intención que el DELETE tiene bloqueada.
      expect(calls).not.toContain(f.key);
      expect(await pending(f.id)).toHaveLength(1);
    } finally { finish.resolve(); }
    await rejected;
    expect(await status(f.id)).toBe('active');
    await reconciliarBorradosPendientes(app, consulta, { now: new Date(Date.now() + 600_000) });
    expect(await status(f.id)).toBe('delete_failed');
  });

  it('si el barrido limpia entre transacciones, vuelve a confirmar intención antes de R2', async () => {
    const f = await source('intervalo'); let connections = 0; let deletes = 0;
    const intercepted = new Proxy(app, { get(target, prop) {
      if (prop !== 'connect') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
      return async () => {
        connections += 1;
        if (connections === 2) {
          await reconciliarBorradosPendientes(owner, { async estado() { return 'presente'; } }, { minAgeMs: 0 });
          expect(await pending(f.id)).toEqual([]);
        }
        return target.connect();
      };
    } });
    await eliminarFuente(intercepted, input(f.id, async keys => {
      deletes += 1; expect(await pending(f.id)).toHaveLength(1);
      return { borradas: keys, fallidas: [] };
    }));
    expect(connections).toBe(4); expect(deletes).toBe(1);
    expect((await pending(f.id))[0].confirmed_at).not.toBeNull();
    await reconciliarBorradosPendientes(app, { async estado() { throw new Error('fuente ausente: no hace falta HEAD'); } }, { minAgeMs: 0 });
    expect(await pending(f.id)).toEqual([]);
  });

  it('tres intervalos barridos agotan reintento sin un solo DELETE de R2', async () => {
    const f = await source('intervalo-repetido'); let connections = 0;
    const intercepted = new Proxy(app, { get(target, prop) {
      if (prop !== 'connect') { const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; }
      return async () => {
        connections += 1;
        if (connections % 2 === 0) await owner.query('DELETE FROM pending_file_deletions WHERE source_id=$1', [f.id]);
        return target.connect();
      };
    } });
    let deletes = 0;
    await expect(eliminarFuente(intercepted, input(f.id, async keys => { deletes++; return { borradas: keys, fallidas: [] }; }))).rejects.toThrow(/Vuelve a intentarlo/);
    expect(connections).toBe(6); expect(deletes).toBe(0); expect(await status(f.id)).toBe('active');
  });

  it('dos fuentes compartidas confirmadas se eliminan concurrentemente sin destruir antes de la última', async () => {
    const a = await source('a'); const b = await source('b', a.key); const deleted: string[] = [];
    const borrar = async (keys: string[]) => { deleted.push(...keys); return { borradas: keys, fallidas: [] }; };
    // owner tiene conexiones para concurrencia REAL, no serializada por max=1.
    await Promise.all([eliminarFuente(owner, input(a.id, borrar)), eliminarFuente(owner, input(b.id, borrar))]);
    expect(deleted).toEqual([a.key]);
    expect(await status(a.id)).toBeUndefined(); expect(await status(b.id)).toBeUndefined();
  });

  it('un procesamiento en curso conserva pendiente y no puede revivir delete_failed después', async () => {
    const f = await source('reindexado'); await aged(f.id, f.key);
    const started = gate(); const finish = gate();
    const processing = withTenant(app, tenant, c => processSource(c, { tenantId: tenant, sourceId: f.id, pdfBytes: new Uint8Array([1]) }, {
      pdf: { async extract() { started.resolve(); await finish.promise; return 'texto de archivo ya descargado'; } }, embed,
    }));
    await started.promise;
    try {
      const result = await reconciliarBorradosPendientes(owner, { async estado() { return 'ausente'; } });
      expect(result.ocupadas).toBeGreaterThanOrEqual(1); expect(await pending(f.id)).toHaveLength(1);
    } finally { finish.resolve(); }
    await processing;
    await reconciliarBorradosPendientes(app, { async estado() { return 'ausente'; } });
    expect(await status(f.id)).toBe('delete_failed');
    const late = await withTenant(app, tenant, c => processSource(c, { tenantId: tenant, sourceId: f.id, pdfBytes: new Uint8Array([1]) }, {
      pdf: { async extract() { throw new Error('no debe reprocesar un archivo destruido'); } }, embed,
    }));
    expect(late.status).toBe('delete_failed'); expect(await status(f.id)).toBe('delete_failed');
  });

  it('101 pendientes: los primeros 100 HEAD desconocidos no bloquean al último para siempre', async () => {
    const rows = (await owner.query(
      `INSERT INTO sources(tenant_id,kind,name,r2_key,status)
       SELECT $1::uuid,'pdf','fairness-' || i,$1::uuid::text || '/conocimiento/fairness-' || i || '.pdf','active'
         FROM generate_series(1,101) i RETURNING id,r2_key`, [tenant],
    )).rows;
    const last = rows.find(r => r.r2_key.endsWith('/fairness-101.pdf'))!;
    await owner.query(
      `INSERT INTO pending_file_deletions(tenant_id,source_id,r2_key,created_at)
       SELECT tenant_id,id,r2_key,now()-CASE WHEN id=$2 THEN interval '10 minutes' ELSE interval '20 minutes' END
         FROM sources WHERE tenant_id=$1`, [tenant, last.id],
    );
    const methods: string[] = [];
    const consulta = consultarR2({ endpoint: 'https://storage.test', bucket: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture' }, (async (url, init) => {
      methods.push(init?.method ?? 'GET');
      return new Response(null, { status: String(url).includes('/fairness-101.pdf?') ? 404 : 403 });
    }) as typeof fetch)!;
    await reconciliarBorradosPendientes(app, consulta);
    expect(await status(last.id)).toBe('active');
    expect((await pending(last.id))[0].last_attempted_at).toBeNull();
    await reconciliarBorradosPendientes(app, consulta);
    expect(await status(last.id)).toBe('delete_failed');
    expect(await pending(last.id)).toEqual([]);
    expect((await owner.query('SELECT 1 FROM pending_file_deletions WHERE tenant_id=$1', [tenant])).rowCount).toBe(100);
    expect(new Set(methods)).toEqual(new Set(['HEAD']));
    expect(methods.length).toBe(200);
  });

  it('RLS real aísla intenciones; el selector global solo expone ids de tenants con trabajo', async () => {
    const f = await source('aislada'); await aged(f.id, f.key);
    const other = randomUUID();
    const flags = (await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(flags).toEqual({ rolsuper: false, rolbypassrls: false });
    expect((await app.query('SELECT * FROM pending_file_deletions')).rows).toEqual([]);
    expect(await withTenant(app, other, c => c.query('SELECT * FROM pending_file_deletions WHERE source_id=$1', [f.id]))).toMatchObject({ rowCount: 0 });
    await expect(withTenant(app, other, c => c.query('INSERT INTO pending_file_deletions(tenant_id,source_id,r2_key) VALUES($1,$2,$3)', [tenant, randomUUID(), f.key]))).rejects.toThrow(/row-level security/);
    const ids = (await app.query('SELECT * FROM tenants_con_borrados_de_conocimiento(now())')).rows;
    expect(ids).toContainEqual({ tenant_id: tenant });
    expect(ids.every(row => Object.keys(row).join() === 'tenant_id')).toBe(true);
  });
});
