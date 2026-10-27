import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parse } from 'protobufjs';
import { describe, expect, it, vi } from 'vitest';

const ejecutar = promisify(execFile);
// Campos del protocolo público OTLP, no del serializador de la aplicación:
// opentelemetry-proto/opentelemetry/proto/{collector/logs,logs,common,resource}/v1.
const schema = parse(`syntax = "proto3";
message Value { string stringValue = 1; }
message Attribute { string key = 1; Value value = 2; }
message Resource { repeated Attribute attributes = 1; }
message Log { fixed64 timeUnixNano = 1; int32 severityNumber = 2; string severityText = 3; Value body = 5; repeated Attribute attributes = 6; bytes traceId = 9; bytes spanId = 10; }
message ScopeLogs { repeated Log logRecords = 2; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scopeLogs = 2; }
message Export { repeated ResourceLogs resourceLogs = 1; }`).root.lookupType('Export');
type Registro = { body: { stringValue: string }; attributes: Array<{ key: string; value: { stringValue: string } }>; traceId: string; spanId: string; severityNumber: number };
type Sobre = { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }; scopeLogs: Array<{ logRecords: Registro[] }> }> };

/**
 * Los dos presupuestos de tiempo, y cuál manda (#1089).
 *
 * Esta prueba levanta un receptor OTLP de verdad y lanza un proceso hijo que
 * emite contra él. O sea que hay DOS relojes: el del hijo —que existe para
 * cazarlo si se cuelga, con un mensaje que dice qué pasó— y el de vitest, que
 * corta la prueba entera.
 *
 * Estaban al revés: el hijo tenía 8 s y vitest usaba su default de 5, así que
 * en una máquina cargada el corte llegaba desde afuera, el guardia del hijo
 * nunca se alcanzaba, y el fallo que se veía —«Test timed out in 5000ms»— no
 * era el que la prueba sabe explicar. Medido: tres corridas seguidas en la
 * misma rama, pasó 2.
 *
 * La regla es que **el de afuera tiene que ser mayor que el de adentro**. Si
 * alguien toca uno de los dos números, tiene que mover el otro: un hijo
 * colgado lo caza SU timeout, no el de vitest.
 */
const TOPE_DEL_HIJO_MS = 8_000;
/** Con holgura para el arranque del hijo y el cierre del receptor. */
const TOPE_DE_LA_PRUEBA_MS = TOPE_DEL_HIJO_MS + 7_000;

async function correr(modo = 'normal', opciones: { exporter?: string; formato?: string; respuesta?: 'ok' | 'rechazo' | 'silencio'; protocolo?: string; endpoint?: string } = {}) {
  const cuerpos: Sobre[] = []; const autorizaciones: Array<string | undefined> = []; let peticionesLogs = 0;
  const servidor = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/logs') {
        peticionesLogs++;
        autorizaciones.push(req.headers.authorization);
        cuerpos.push(schema.toObject(schema.decode(Buffer.concat(chunks)), { bytes: String }) as Sobre);
        if (opciones.respuesta === 'silencio') return;
        if (opciones.respuesta === 'rechazo') { res.writeHead(401); res.end('denegado'); return; }
      }
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }); res.end();
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const port = (servidor.address() as { port: number }).port;
  try {
    const { stdout, stderr } = await ejecutar(process.execPath, [join(__dirname, 'fixtures/logs-otlp.cjs'), modo, 'argv-privado-no-exportar'], {
      timeout: TOPE_DEL_HIJO_MS, maxBuffer: 2 * 1024 * 1024,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTEL_|SENTRY_|LOG_FORMAT)/.test(k))),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer ficticio-otlp', OTEL_EXPORTER_OTLP_LOGS_HEADERS: '', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: opciones.endpoint || '',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: opciones.protocolo || 'http/protobuf', OTEL_LOGS_EXPORTER: opciones.exporter === undefined ? 'otlp' : opciones.exporter,
        OTEL_TRACES_EXPORTER: 'otlp', LOG_FORMAT: opciones.formato === undefined ? 'json' : opciones.formato, SENTRY_DSN: '',
      },
    });
    return { stdout, stderr, cuerpos, autorizaciones, peticionesLogs, logs: cuerpos.flatMap((c) => c.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords))) };
  } finally { servidor.closeAllConnections(); await new Promise<void>((resolve) => servidor.close(() => resolve())); }
}

describe('console JSON llega por OTLP real a receptor local (#17)', () => {
  // Al describe y no prueba por prueba: las cuatro llaman a `correr`, así que
  // todas tienen el mismo contrato de tiempos y una sola es la que se olvida.
  vi.setConfig({ testTimeout: TOPE_DE_LA_PRUEBA_MS });

  it('tenant/request/trace del request al job, una emisión, redacción y drenaje final', async () => {
    const r = await correr();
    for (const tenant of ['uno','dos']) {
      const request = r.logs.find((l) => l.body.stringValue === `request-${tenant}`)!;
      const jobs = r.logs.filter((l) => l.body.stringValue.startsWith(`job-${tenant}`));
      expect(jobs).toHaveLength(1);
      const job = jobs[0]; const attr = Object.fromEntries(job.attributes.map((a) => [a.key, a.value.stringValue]));
      expect(attr.tenant_id).toBe(tenant); expect(attr.request_id).toBe(`req_${tenant}`);
      expect(job.traceId).toBe(request.traceId); expect(Buffer.from(job.traceId,'base64')).toHaveLength(16);
      expect(Buffer.from(job.traceId,'base64').toString('hex')).toBe(attr.trace_id);
      expect(job.spanId).not.toBe(request.spanId); expect(job.severityNumber).toBe(17);
      expect(attr['exception.stacktrace']).toContain('Error: timeout');
    }
    expect(r.logs.filter((l) => l.body.stringValue === 'drenaje-final')).toHaveLength(1);
    const todo = r.stdout + r.stderr + JSON.stringify(r.cuerpos);
    for (const privado of ['ana@example.invalid','ficticio-bearer','ficticia-clave','ficticio-query','ficticia-cause','ficticia-meta','conversación privada','argv-privado-no-exportar','ficticio-otlp','contenido privado Axios','ficticio-axios','solicitud privada Axios','respuesta privada Axios','prompt privado Axios']) expect(todo).not.toContain(privado);
    expect(r.autorizaciones).toEqual(['Bearer ficticio-otlp']);
    expect(r.stderr).not.toContain('duplicate registration');
    expect(r.cuerpos[0].resourceLogs[0].resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue).toBe('iaxti-logs-17');
    expect(JSON.parse(r.stderr.split('\n').find((l) => l.includes('job-uno'))!).msg).toBe(r.logs.find((l) => l.body.stringValue.startsWith('job-uno'))!.body.stringValue);
  });
  it.each([{ exporter: '' }, { exporter: 'none' }, { formato: '' }, { protocolo: 'grpc' }, { endpoint: 'https://user:clave@host.invalid?token=secreto' }])('no exporta sin consentimiento/configuración compatible %j', async (opciones) => {
    const r = await correr('normal', opciones); expect(r.peticionesLogs).toBe(0); expect(r.stdout).toContain('request-uno');
    expect(r.stderr).not.toContain('user:clave'); expect(r.stderr).not.toContain('token=secreto');
  });
  it('rechazo del exportador avisa localmente y no se convierte en otro lote', async () => {
    const r = await correr('normal', { respuesta: 'rechazo' });
    expect(r.peticionesLogs).toBe(1); expect(r.stderr).toContain('otel:');
    expect(r.logs.some((l) => l.body.stringValue.startsWith('otel:'))).toBe(false);
  });
  it('receptor que acepta TCP pero no responde no deja el proceso colgado', async () => {
    const r = await correr('normal', { respuesta: 'silencio' }); expect(r.peticionesLogs).toBe(1); expect(r.stderr).toContain('otel:');
  });
  it('saturación conserva consola, limita cola y no duplica los lotes al cerrar', async () => {
    const r = await correr('saturacion');
    const mensajes = r.logs.map((l) => l.body.stringValue);
    expect(mensajes).toHaveLength(512); expect(new Set(mensajes).size).toBe(512);
    expect(r.stdout).toContain('lote-699'); expect(r.peticionesLogs).toBe(4);
  });
});
