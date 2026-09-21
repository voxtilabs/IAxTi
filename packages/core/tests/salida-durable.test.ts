import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = join(__dirname, '../../..');
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist', 'tests', '.next', 'e2e'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('no reabrir la brecha PostgreSQL → Redis (#380)', () => {
  it('todo productor declara política; solo el adaptador durable abre la cola outbound', () => {
    const violations: string[] = [];
    let producers = 0;
    const publishers: string[] = [];
    for (const file of [...sources(join(root, 'apps')), ...sources(join(root, 'packages/modules'))]) {
      const path = relative(root, file);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sendMessage') {
          producers++;
          const input = node.arguments[1];
          const policy = input && ts.isObjectLiteralExpression(input) && input.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'delivery');
          if (!policy) violations.push(`${path}: sendMessage sin política durable`);
        }
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)
            && ['createQueue', 'Queue'].includes(node.expression.text)
            && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'outbound') {
          publishers.push(path);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(producers).toBeGreaterThanOrEqual(7);
    expect(violations).toEqual([]);
    expect(publishers).toEqual(['apps/workers/src/outbound-dispatch.ts']);
  });
});
