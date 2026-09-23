import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { inventario, inventarioDelRepositorio, rutasInexistentes } from './support/rutas-frontend';

const api = `
@Controller('contacts')
class Contacts { @Get() list() {} @Get(':id') one() {} @Post(':id/notes') note() {} }
@Controller() class Channels { @Get('channels') list() {} }
@Controller('tags') class Tags { @Get() list() {} }
@Controller('platform/audit') class Audit { @Get() list() {} @Get('export') export() {} }
@Controller('platform/health') class Health { @Get() health() {} }
// @Controller('inventada') class Fake { @Get() list() {} }
`;
const examinar = (web: string) => inventario({ 'apps/api/src/example.controller.ts': api, 'apps/web/example.tsx': web });

describe('guarda de rutas frontend/API (#360)', () => {
  it('el incidente de campañas falla aunque catch lo convierta en una lista vacía', () => {
    const datos = examinar(`
apiFetch<Canal[]>(config, session, tenant, '/canales').catch(() => []);
apiFetch(config, session, tenant, '/etiquetas').catch(() => []);
apiFetch(config, session, tenant, '/channels');
`);
    expect(rutasInexistentes(datos)).toEqual([
      { archivo: 'apps/web/example.tsx', linea: 2, ruta: '/canales', metodo: 'GET' },
      { archivo: 'apps/web/example.tsx', linea: 3, ruta: '/etiquetas', metodo: 'GET' },
    ]);
  });

  it('resuelve wrappers, variables, ternarios, query y sufijos junto a parámetros', () => {
    const datos = examinar(`
const path = filtro ? '/contacts?q=Ana' : '/tags';
apiFetch(config, session, tenant, path);
async function accion(id: string, suffix: string) {
  return apiFetch(config, session, tenant, \`/contacts/\${id}\${suffix}\`);
}
accion(id, '/notes');
accion(id, '/ruta-inventada');
const llamar = (path: string) => fetch(\`\${config.apiUrl}/v1\${path}\`);
llamar('/platform/health');
llamar(\`/platform/audit/export?format=\${format}\`);
llamar('/platform/inventada');
`);
    expect(rutasInexistentes(datos).map((r) => r.ruta)).toEqual([
      '/contacts/«valor»/ruta-inventada', '/platform/inventada',
    ]);
    expect(datos.llamadas).toHaveLength(7);
  });

  it('escanea administración y controladores múltiples; ignora comentarios y URLs externas', () => {
    const datos = inventario({
      'apps/api/src/example.controller.ts': api,
      'apps/admin/components/test.tsx': `
// apiFetch(config, session, tenant, '/comentario');
fetch(\`\${internalApiUrl()}/v1/platform/health\`);
fetch('https://externo.invalid/archivo');
fetch(\`\${config.apiUrl}/v1/inventada\`);
`,
    });
    expect(datos.declaradas).toContain('/tags');
    expect(datos.declaradas).not.toContain('/inventada');
    expect(datos.llamadas).toHaveLength(2);
    expect(rutasInexistentes(datos)).toEqual([
      { archivo: 'apps/admin/components/test.tsx', linea: 5, ruta: '/inventada', metodo: 'GET' },
    ]);
  });

  it('sigue useCallback y las uniones de literales de props importadas', () => {
    const datos = inventario({
      'apps/api/src/example.controller.ts': api,
      'apps/web/child.tsx': `export function Child(props: { onSelect: (suffix: 'notes' | 'inexistente') => void }) { return null; }`,
      'apps/web/example.tsx': `
import { Child } from './child';
const llamar = useCallback((path: string) => apiFetch(config, session, tenant, path), []);
llamar('/channels');
const screen = <Child onSelect={(suffix) => apiFetch(config, session, tenant, \`/contacts/\${id}/\${suffix}\`)} />;
`,
    });
    expect(datos.llamadas.map((r) => r.ruta)).toEqual(['/channels', '/contacts/«valor»/notes', '/contacts/«valor»/inexistente']);
    expect(rutasInexistentes(datos).map((r) => r.ruta)).toEqual(['/contacts/«valor»/inexistente']);
  });

  it('una ruta opaca no consigue verde por coincidir con cualquier endpoint', () => {
    expect(rutasInexistentes(examinar(`apiFetch(config, session, tenant, construirRuta());`))).toHaveLength(1);
  });

  // 30 s y no los 5 por defecto: este caso LEE EL REPOSITORIO ENTERO —los
  // controladores de la API y cada llamada de web y admin— y eso crece con
  // el producto. Tardaba 5,4 s con la máquina ocupada y fallaba por tiempo,
  // que se lee como "hay una ruta rota" y no lo es. Un tope generoso sigue
  // atrapando un escaneo que se descontrola de verdad.
  it('toda llamada de web y admin tiene una ruta declarada en la API', () => {
    const datos = inventarioDelRepositorio(join(__dirname, '..', '..', '..'));
    expect(datos.declaradas.length).toBeGreaterThan(150);
    expect(datos.llamadas.length).toBeGreaterThan(140);
    expect(datos.llamadas.some((r) => r.archivo.startsWith('apps/admin/'))).toBe(true);
    const rotas = rutasInexistentes(datos);
    expect(rotas, 'Rutas que el frontend pide y la API no declara:\n' + rotas.map((r) =>
      `  ${r.archivo}:${r.linea} → ${r.ruta}`).join('\n') +
      '\nUna ruta dinámica debe poder resolverse a sus literales y parámetros.').toEqual([]);
  }, 30_000);
});
