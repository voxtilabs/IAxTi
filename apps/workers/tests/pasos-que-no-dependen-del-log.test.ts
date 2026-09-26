import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Ningún paso del trabajo cuelga de un `if` de log (#542).
 *
 * El aviso de borrado de un tenant vivía DENTRO del `if` que decide si se
 * imprime la línea de facturación:
 *
 *     if (res.issued + res.overdue + res.readOnly > 0) {
 *       console.log(`scheduled: billing — …`);
 *       const cola = await avisarBorradoPendiente(pool);   // ← acá
 *       …
 *     }
 *
 * O sea que el aviso solo corría los días en que algún negocio facturó, cayó en
 * mora o pasó a solo lectura. En un despliegue chico —el primer año— hay días
 * enteros en que esos tres contadores son cero, y entonces el aviso no salía:
 * `deletion_warned_at` se quedaba en NULL para siempre. La cola del SuperAdmin
 * mostraba la fila como «sin avisar» y a los 90 días igual la marcaba «cumple el
 * plazo», sin nada que bloqueara el borrado. Una pyme en mora se borraba
 * físicamente sin haber recibido nunca el aviso de que tenía 15 días para
 * exportar sus datos.
 *
 * Se revisa por AST y NO por indentación, que es justo lo que engañaba: el
 * bloque estaba escrito al mismo nivel que el resto del `case` y la llave de
 * más quedaba doce líneas abajo.
 */
const RUTA = join(__dirname, '..', 'src', 'main.ts');

/**
 * Llamadas que hacen trabajo de verdad y no pueden colgar de un log. La lista
 * es corta a propósito: cada una es un paso cuyo silencio no se nota.
 */
const PASOS = [
  'avisarBorradoPendiente',
  'sweepBilling',
  'sweepTimeRules',
  'sweepSequences',
  'markStalledDeals',
  'expireLinks',
  'expireSources',
  'sweepDueActivities',
  'reindexarPendientes',
  'flushApiUsage',
  'deliverWebhooks',
];

const fuente = ts.createSourceFile(
  'main.ts',
  readFileSync(RUTA, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

/** ¿Este nodo está dentro de un `if` cuya condición mira un contador de log? */
function dentroDeUnIf(nodo: ts.Node): string | null {
  for (let n: ts.Node | undefined = nodo.parent; n; n = n.parent) {
    if (ts.isIfStatement(n)) return n.expression.getText().replace(/\s+/g, ' ').slice(0, 80);
    // Un `case` o el cuerpo de una función corta la búsqueda: más arriba ya no
    // es «dentro de un if» en el sentido que importa.
    if (ts.isCaseClause(n) || ts.isFunctionLike(n)) return null;
  }
  return null;
}

function llamadas(nombre: string): ts.Node[] {
  const salida: ts.Node[] = [];
  const recorrer = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText() === nombre) salida.push(n);
    ts.forEachChild(n, recorrer);
  };
  recorrer(fuente);
  return salida;
}

describe('los pasos del trabajo no cuelgan de un if de log (#542)', () => {
  it('el escáner encuentra las llamadas (si esto falla, el escáner se rompió)', () => {
    const encontradas = PASOS.filter((p) => llamadas(p).length > 0);
    expect(encontradas.length, `no encontré ninguna de: ${PASOS.join(', ')}`).toBeGreaterThan(6);
  });

  it('ninguno está dentro de un if', () => {
    const atrapados: string[] = [];
    for (const paso of PASOS) {
      for (const llamada of llamadas(paso)) {
        const condicion = dentroDeUnIf(llamada);
        if (condicion) {
          const { line } = fuente.getLineAndCharacterOfPosition(llamada.getStart());
          atrapados.push(`${paso} (línea ${line + 1}) dentro de: if (${condicion})`);
        }
      }
    }
    expect(
      atrapados,
      'Estos pasos solo corren cuando se cumple una condición que no es la suya. Si esa ' +
        'condición es de un log, el trabajo se salta los días en que no hay nada que ' +
        'loguear — y no falla nada:\n  ' + atrapados.join('\n  '),
    ).toEqual([]);
  });

  it('el aviso de borrado sigue en el barrido de facturación', () => {
    // Explícito, porque es el caso que motivó esta guarda: que exista no basta,
    // tiene que estar en el barrido que corre todos los días.
    const enBilling = llamadas('avisarBorradoPendiente');
    expect(enBilling.length, 'nadie llama al aviso de borrado').toBe(1);
    for (let n: ts.Node | undefined = enBilling[0]; n; n = n.parent) {
      if (ts.isCaseClause(n)) {
        expect(n.expression?.getText()).toContain('billing.sweep');
        return;
      }
    }
    throw new Error('el aviso de borrado no está dentro de ningún case');
  });
});
