/**
 * Regla: un `.catch()` sobre una lectura que usa el `PoolClient` de QUIEN LLAMA
 * no es una degradación, es la transacción ajena envenenada (#966).
 *
 * ## Qué caza, y por qué no alcanzaba un grep
 *
 * El patrón es siempre el mismo y la intención siempre es buena:
 *
 *     const extra = await leerAlgo(client, …).catch(() => null);
 *
 * «ese dato es una mejora, no un requisito». Pero en Postgres la sentencia que
 * falla aborta el bloque ENTERO, así que lo que queda no es una degradación: es
 * la transacción del llamador inservible, y lo que siga contesta `current
 * transaction is aborted, commands ignored until end of transaction block` — un
 * mensaje que no nombra la tabla, ni la consulta, ni el permiso que faltaba.
 *
 * #962 lo arregló en un sitio y dejó `degradarSinRomper`; #970 convirtió once
 * más. El cuarto criterio de #966 —la guarda— quedó abierto a propósito, y la
 * razón de que sea una regla de ESLint y no un escáner de texto como los de
 * #664 o #703 está escrita en el issue: los dos greps que se intentaron
 * descuadraban con los literales SQL de varias líneas, y «para no volver a
 * adivinar dónde termina una consulta» hace falta el AST. Acá lo hay: la regla
 * sabe qué es una llamada, qué es un string y a qué parámetro apunta un nombre.
 *
 * ## Cómo decide que el cliente es AJENO
 *
 * No por el nombre de la variable —eso es la adivinanza que se quiere evitar—
 * sino resolviéndola hasta donde nace:
 *
 *  1. un parámetro anotado `PoolClient` (o `PoolClient | Pool`): el cliente se
 *     recibió, o sea que la transacción es de otro;
 *  2. el parámetro del callback de `withTenant`, `withAuthenticatedUser`,
 *     `sinTriggers` o `degradarSinRomper`: ahí dentro hay una transacción
 *     abierta por el envoltorio.
 *
 * Un `Pool` NO entra: cada consulta va en su propia conexión, un fallo no deja
 * nada abortado y ahí `.catch` sí degrada.
 *
 * ## Qué no caza, a propósito
 *
 * Un handler que RELANZA. `.catch(notFound)` y `.catch((e) => { throw … })`
 * dejan morir la transacción igual, y el cliente recibe el error correcto: no
 * hay degradación silenciosa que tapar. Eran nueve sitios en
 * `conversations.controller.ts` y `arranque.controller.ts`, y revisarlos otra
 * vez es trabajo tirado.
 */

const ENVOLTORIOS_CON_TRANSACCION = new Set([
  'withTenant',
  'withAuthenticatedUser',
  'sinTriggers',
  'degradarSinRomper',
]);

/**
 * Recorrer un subárbol sin caer en el `parent`.
 *
 * Esto empezó siendo un `JSON.stringify(nodo)` y la regla reventaba en el
 * primer archivo: los nodos del AST tienen referencia a su padre, así que el
 * árbol es cíclico y `stringify` tira `Converting circular structure to JSON`.
 * El atajo no existe; hay que caminarlo.
 */
function alguno(nodo, cumple, visto = new Set()) {
  if (!nodo || typeof nodo !== 'object' || visto.has(nodo)) return false;
  visto.add(nodo);
  if (Array.isArray(nodo)) return nodo.some((hijo) => alguno(hijo, cumple, visto));
  if (typeof nodo.type === 'string' && cumple(nodo)) return true;
  for (const [clave, valor] of Object.entries(nodo)) {
    if (clave === 'parent' || clave === 'loc' || clave === 'range') continue;
    if (valor && typeof valor === 'object' && alguno(valor, cumple, visto)) return true;
  }
  return false;
}

/**
 * ¿El tipo escrito a mano ES un `PoolClient`?
 *
 * Mirando el subárbol entero —que es lo primero que probé— esto se acusaba
 * solo: el ayudante de `crm/tests/pipelines-editar.test.ts` es
 *
 *     const en = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(admin, tenant, fn);
 *
 * y ahí `PoolClient` aparece, pero `fn` no es un cliente: es una función que
 * RECIBE uno. Así que se mira el tipo de arriba —o los miembros de la unión,
 * que es como está escrito `Pick<Pool, 'query'> | PoolClient`— y no lo que
 * haya anidado adentro.
 */
function anotaPoolClient(nodo) {
  const anotacion = nodo?.typeAnnotation?.typeAnnotation;
  if (!anotacion) return false;
  const esCliente = (t) =>
    t?.type === 'TSTypeReference' && t.typeName?.type === 'Identifier' && t.typeName.name === 'PoolClient';
  if (anotacion.type === 'TSUnionType') return anotacion.types.some(esCliente);
  return esCliente(anotacion);
}

/** ¿Este parámetro es el `(c) => …` de un envoltorio que abre transacción? */
function esCallbackDeEnvoltorio(definicion) {
  const funcion = definicion.node;
  const llamada = funcion?.parent;
  if (llamada?.type !== 'CallExpression') return false;
  const callee = llamada.callee;
  const nombre = callee?.type === 'Identifier' ? callee.name : callee?.property?.name;
  return ENVOLTORIOS_CON_TRANSACCION.has(nombre ?? '');
}

/** ¿El handler del catch relanza? Entonces no hay degradación que tapar. */
function relanza(handler) {
  if (!handler) return false;
  // Un identificador —`.catch(notFound)`— es una función con nombre, y las que
  // hay en este repositorio relanzan. Darle el beneficio de la duda es lo que
  // evita que la regla acuse a los 404 bien escritos.
  if (handler.type === 'Identifier' || handler.type === 'MemberExpression') return true;
  if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression') {
    return true;
  }
  return alguno(handler.body, (n) => n.type === 'ThrowStatement');
}

export const catchSobreClienteAjeno = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No tragarse el error de una lectura hecha con el PoolClient de quien llama: la transacción queda abortada (#966).',
    },
    schema: [],
    messages: {
      envenena:
        'Este `.catch()` usa el PoolClient de quien llama (`{{cliente}}`): la sentencia que falla aborta la transacción ENTERA, así que no degrada nada — deja al llamador con `current transaction is aborted`. Pasalo por `degradarSinRomper` (#962), que lo envuelve en un SAVEPOINT y te da el error de verdad en `alFallar`.',
    },
  },
  create(context) {
    const fuente = context.sourceCode ?? context.getSourceCode();

    /** Buscar el nombre hacia arriba, como lo resolvería el intérprete. */
    function variableDe(nombre, alcance) {
      for (let s = alcance; s; s = s.upper) {
        const v = s.variables.find((x) => x.name === nombre);
        if (v) return v;
      }
      return null;
    }

    /** El nombre resuelve a un cliente que vino de afuera. */
    function esClienteAjeno(nodo, alcance) {
      if (nodo?.type !== 'Identifier') return false;
      const definicion = variableDe(nodo.name, alcance)?.defs?.[0];
      if (!definicion || definicion.type !== 'Parameter') return false;
      if (anotaPoolClient(definicion.name)) return true;
      return esCallbackDeEnvoltorio(definicion);
    }

    /**
     * La tercera forma: un ayudante local que CAPTURA el cliente.
     *
     *     const uno = async (sql, params) => (await client.query(sql, params)).rows;
     *     const actividades = await uno('SELECT …', par).catch(() => []);
     *
     * Así están los dos que quedaban en `crm/titular.ts`, y ahí es donde más
     * pesa: la supresión del titular es UNA transacción a propósito (#903), así
     * que una lectura que se degrada mata el borrado entero y el 404 que
     * contesta no habla de borrar nada. Ningún grep podía ver esto —el cliente
     * no aparece en la línea del `.catch`— y por nombre tampoco: hay que
     * mirar el cuerpo del ayudante.
     */
    function usaUnClienteAjeno(callee, alcance) {
      if (callee?.type !== 'Identifier') return false;
      const definicion = variableDe(callee.name, alcance)?.defs?.[0];
      const cuerpo = definicion?.node?.init;
      if (
        cuerpo?.type !== 'ArrowFunctionExpression' &&
        cuerpo?.type !== 'FunctionExpression'
      ) {
        return false;
      }
      const alcanceDelAyudante = fuente.getScope(cuerpo);
      /**
       * Y el cliente tiene que venir de AFUERA del ayudante.
       *
       * Si nace adentro, el ayudante ABRE la transacción y la cierra antes de
       * volver —`const en = (fn) => withTenant(admin, tenant, fn)`—, así que
       * el `.catch` de quien lo llama recibe el fallo con la transacción ya
       * terminada y degradar ahí está bien. Es la diferencia entre capturar el
       * cliente de otro y crear uno propio, y sin esta condición la regla
       * acusaba a las pruebas que hacen justamente lo correcto.
       */
      const deAfuera = (nodo) => {
        const definicion = variableDe(nodo.name, alcanceDelAyudante)?.defs?.[0];
        const donde = definicion?.name?.range;
        return !donde || donde[0] < cuerpo.range[0] || donde[1] > cuerpo.range[1];
      };
      return alguno(
        cuerpo.body,
        (n) => n.type === 'Identifier' && esClienteAjeno(n, alcanceDelAyudante) && deAfuera(n),
      );
    }

    return {
      CallExpression(nodo) {
        const callee = nodo.callee;
        if (callee.type !== 'MemberExpression' || callee.property?.name !== 'catch') return;
        // Lo de la izquierda del `.catch` tiene que ser una llamada: es la
        // lectura que se degrada. `promesa.catch(…)` sin llamada no dice nada.
        let lectura = callee.object;
        if (lectura.type !== 'CallExpression') return;
        /**
         * Desenrollar la cadena.
         *
         *     listDeals(client, …).then((r) => r.items).catch(() => [])
         *
         * El `.catch` cuelga del `.then`, no de la lectura, así que mirando un
         * solo nivel el cliente no aparece en ninguna parte. Se baja por los
         * eslabones hasta la llamada que de verdad consulta.
         */
        while (
          lectura.callee?.type === 'MemberExpression' &&
          lectura.callee.object?.type === 'CallExpression' &&
          ['then', 'finally'].includes(lectura.callee.property?.name ?? '')
        ) {
          lectura = lectura.callee.object;
        }
        if (relanza(nodo.arguments[0])) return;

        const alcance = fuente.getScope(nodo);
        /**
         * Las dos formas, y la segunda es la que pesa.
         *
         * `leerAlgo(client, …).catch(…)` pasa el cliente como ARGUMENTO, y es
         * la que los greps de #970 encontraban. Pero `client.query(…).catch(…)`
         * lo tiene como OBJETO de la llamada, y así están los siete seguidos de
         * `crm/titular.ts` —dentro de la transacción única de la supresión del
         * titular (#903), que es justo donde una transacción abortada se come
         * el borrado entero—.
         */
        const candidatos = [...lectura.arguments];
        if (lectura.callee.type === 'MemberExpression') candidatos.push(lectura.callee.object);
        const cliente = candidatos.find((arg) => esClienteAjeno(arg, alcance));
        if (cliente) {
          context.report({ node: nodo, messageId: 'envenena', data: { cliente: cliente.name } });
          return;
        }
        if (usaUnClienteAjeno(lectura.callee, alcance)) {
          context.report({
            node: nodo,
            messageId: 'envenena',
            data: { cliente: `el que captura ${lectura.callee.name}()` },
          });
        }
      },
    };
  },
};

export default { rules: { 'catch-sobre-cliente-ajeno': catchSobreClienteAjeno } };
