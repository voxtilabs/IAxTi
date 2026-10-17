import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { catchSobreClienteAjeno } from '../../../tools/eslint-reglas/catch-sobre-cliente-ajeno.mjs';

/**
 * La regla de #966 tiene sus propios casos, y no por simetría.
 *
 * Una guarda que escanea se puede romper sin ponerse roja: basta con que deje
 * de reconocer la forma. Acá ya pasó dos veces mientras se escribía esta misma
 * regla —primero reventaba con `Converting circular structure to JSON` porque
 * los nodos del AST apuntan a su padre, y después acusaba al ayudante de una
 * prueba que hace justamente lo correcto—. Las dos veces lo que avisó fue
 * correr la regla sobre el repo, no una aserción. Esto es la aserción.
 *
 * Los casos que NO deben dar error son la mitad que importa: una regla que
 * grita de más se apaga igual de rápido que una que no grita.
 */
const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser as never, // el tipo del parser de typescript-eslint no calza con el de eslint 9
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

describe('la regla del catch sobre el cliente ajeno (#966)', () => {
  it('caza las cuatro formas y deja pasar lo que no envenena', () => {
    tester.run('catch-sobre-cliente-ajeno', catchSobreClienteAjeno, {
      valid: [
        // Un Pool: cada consulta en su propia conexión, nada queda abortado.
        `async function f(pool: Pool) { await leer(pool).catch(() => null); }`,
        // Relanza: la transacción muere igual y el cliente recibe su 404.
        `async function f(client: PoolClient) { await leer(client).catch(noExiste); }`,
        `async function f(client: PoolClient) { await leer(client).catch((e) => { throw e; }); }`,
        // El ayudante ABRE la transacción: el `.catch` llega con ella cerrada.
        `const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);
         async function f() { await en((c) => borrar(c, 1)).catch(() => undefined); }`,
        // Ya pasa por el helper: eso es el arreglo, no el defecto.
        `async function f(client: PoolClient) {
           await degradarSinRomper(client, (c) => leer(c), () => null);
         }`,
      ],
      invalid: [
        // 1. El cliente como argumento.
        {
          code: `async function f(client: PoolClient) { await leer(client, 1).catch(() => null); }`,
          errors: [{ messageId: 'envenena' }],
        },
        // 2. El cliente como objeto de la llamada.
        {
          code: `async function f(client: PoolClient) { await client.query('SELECT 1').catch(() => null); }`,
          errors: [{ messageId: 'envenena' }],
        },
        // 3. Un ayudante local que lo CAPTURA: la forma de `crm/titular.ts`,
        //    que ningún grep podía ver.
        {
          code: `async function f(client: PoolClient) {
                   const uno = async (sql: string) => (await client.query(sql)).rows;
                   await uno('SELECT 1').catch(() => []);
                 }`,
          errors: [{ messageId: 'envenena' }],
        },
        // 4. Detrás de un `.then`: la forma de `copilot.ts`.
        {
          code: `async function f(client: PoolClient) {
                   await leer(client).then((r) => r.items).catch(() => []);
                 }`,
          errors: [{ messageId: 'envenena' }],
        },
        // 5. El cliente del callback de `withTenant`, sin anotación de tipo.
        {
          code: `async function f(pool: Pool) {
                   await withTenant(pool, t, async (c) => {
                     await leer(c).catch(() => null);
                   });
                 }`,
          errors: [{ messageId: 'envenena' }],
        },
      ],
    });
  });
});
