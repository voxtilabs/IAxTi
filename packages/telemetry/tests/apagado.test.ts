import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { plazoDeApagado } from '../src/index';

const ejecutar = promisify(execFile);

/**
 * SIGTERM no puede matar un job a mitad de camino.
 *
 * BullMQ garantiza at-least-once: el job que muere en ejecución se vuelve a
 * tomar. Si el proceso se cae entre "le mandé el mensaje al proveedor" y "lo
 * anoté", el reintento manda el mismo WhatsApp otra vez — el cliente lo recibe
 * dos veces y se paga dos veces. Y pasaba en CADA despliegue, porque el único
 * manejador de señales que había hacía `process.exit(0)` sin esperar a nadie.
 *
 * Se prueba en un proceso de verdad y con la señal de verdad: es lo único que
 * comprueba que el manejador esté instalado y que el trabajo en vuelo se
 * espere. Un test en proceso tendría que falsear `process.exit`, que es
 * exactamente la línea que interesa.
 */
describe('apagado ordenado con SIGTERM', () => {
  it('espera el job en vuelo, sigue después de uno que falla, y sale con 0', async () => {
    const { stdout } = await ejecutar(process.execPath, [join(__dirname, 'fixtures/apagado.cjs')], {
      timeout: 20_000,
      env: { ...process.env, SENTRY_DSN: '', OTEL_EXPORTER_OTLP_ENDPOINT: '', LOG_FORMAT: '' },
    });
    const salida = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      jobTerminado: boolean;
      pasos: string[];
      codigo: number;
      nadieTomoLaSenal: boolean;
      enCurso: boolean | null;
    };

    // Lo que importa: el job alcanzó a terminar antes de que el proceso muriera.
    expect(
      salida.nadieTomoLaSenal,
      'Nadie tomó el SIGTERM: el proceso habría muerto con el job a medio hacer.',
    ).toBe(false);
    expect(salida.jobTerminado, `El job murió a mitad de camino. Salida: ${stdout}`).toBe(true);
    // En el orden en que se registraron, y el que se rompe no corta la fila.
    expect(salida.pasos).toEqual(['productor', 'cola', 'base']);
    expect(salida.codigo).toBe(0);
    expect(salida.enCurso).toBe(true);
  }, 25_000);

  it('el plazo por omisión cabe dentro de la gracia del orquestador', () => {
    // Un plazo mayor que el del orquestador es una promesa que no se cumple:
    // el SIGKILL llega igual y el drenaje queda a medias sin que nadie lo
    // cuente. Docker espera 10 s por omisión.
    expect(plazoDeApagado({} as NodeJS.ProcessEnv)).toBeLessThan(10_000);
    expect(plazoDeApagado({ SHUTDOWN_TIMEOUT_MS: '25000' } as NodeJS.ProcessEnv)).toBe(25_000);
    // Lo que no es un número no apura ni cuelga el apagado: se usa el defecto.
    expect(plazoDeApagado({ SHUTDOWN_TIMEOUT_MS: 'pronto' } as NodeJS.ProcessEnv)).toBe(8_000);
    expect(plazoDeApagado({ SHUTDOWN_TIMEOUT_MS: '  ' } as NodeJS.ProcessEnv)).toBe(8_000);
  });
});
