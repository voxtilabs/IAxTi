import { describe, expect, it } from 'vitest';
import { iniciales } from '../src/react/ui/avatar';
import { cn } from '../src/react/ui/cn';

// Los componentes shadcn-style se validan sobre todo por el escáner de hex
// (pulso.test.ts los recorre) y el typecheck; aquí, la lógica pura.
describe('componentes Pulso (shadcn-style)', () => {
  it('cn mergea clases de Tailwind sin duplicar utilidades', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
    const oculto = (['a'] as string[]).length === 0;
    expect(cn('text-ink', oculto && 'oculto', 'font-medium')).toBe('text-ink font-medium');
  });

  it('las iniciales caen bien: nombre completo, uno solo, o teléfono', () => {
    expect(iniciales('María Paz Soto')).toBe('MP');
    expect(iniciales('Camila')).toBe('C');
    // Sin nombre devuelve null, y NO los dos últimos dígitos del teléfono
    // (#1106). Eso hacía que la bandeja mostrara círculos con «78», «48»,
    // «30»: hay que decodificarlos, parecen un contador y no distinguen a
    // nadie. Quien pinta decide; el avatar pone una silueta neutra.
    expect(iniciales(null)).toBeNull();
    expect(iniciales('   ')).toBeNull();
  });

  it('los roles del Badge son exactamente los del CHECK de tags (crm)', async () => {
    const fuente = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/react/ui/badge.tsx', import.meta.url), 'utf8'),
    );
    for (const rol of ['action', 'good', 'warn', 'bad', 'info', 'neutral']) {
      expect(fuente).toContain(`${rol}:`);
    }
  });
});
