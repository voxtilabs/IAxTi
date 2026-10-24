// El dataset de regresión del REPO (#53): corre en CI antes de cambiar
// prompt, modelo o proveedor. Sin llave, avisa y se salta (el gate real
// corre cuando el secret GOOGLE_GENERATIVE_AI_API_KEY existe) — jamás
// inventa un score. Falla si el promedio baja del baseline versionado.
//
//   pnpm --filter @iaxti/module-agents exec node scripts/run-evals.mjs
//
// Los prompts se IMPORTAN del producto compilado (#1029): este script tenía
// su propia copia del formato de sugerencia, y ya había divergido — el
// producto ganó el campo `accion` (#1000) y el gate seguía midiendo el
// formato viejo. Un gate que evalúa un prompt que el producto no usa es la
// clase de defecto de #869: verde, vigilando otra cosa.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(join(raiz, 'evals', 'baseline.json'), 'utf8'));

// Del dist y no de la fuente: este script es JS plano y corre tras el build
// (en CI, el paso Build va antes). Si no hay dist, se dice qué falta en vez
// de reventar con un stack de resolución.
let FORMATO_SUGERENCIA, formatoAutonomo, accionesParaElPrompt;
try {
  ({ FORMATO_SUGERENCIA } = await import('../dist/domain/parser.js'));
  ({ formatoAutonomo } = await import('../dist/domain/escalation.js'));
  ({ accionesParaElPrompt } = await import('../dist/application/acciones-en-la-conversacion.js'));
} catch (err) {
  console.error(
    'evals: no pude cargar los prompts del producto desde dist/ — compila primero\n' +
      `       (pnpm turbo build --filter=@iaxti/module-agents). Detalle: ${String(err?.message ?? err).slice(0, 160)}`,
  );
  process.exit(1);
}

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!apiKey) {
  console.log('evals: sin GOOGLE_GENERATIVE_AI_API_KEY — se salta (el gate corre cuando el secret exista).');
  process.exit(0);
}

const google = createGoogleGenerativeAI({ apiKey });
// Por ALIAS, no por versión fija: `gemini-2.5-flash` quedó retirado para
// llaves nuevas y este script se caía con 404 antes de evaluar nada (#308).
// Se puede fijar con EVAL_MODEL para comparar dos versiones a mano.
const candidato = google(process.env.EVAL_MODEL ?? 'gemini-flash-latest');
// El juez va por el modelo grande: juzgar pide más que responder.
const juez = google(process.env.EVAL_JUDGE_MODEL ?? 'gemini-pro-latest');

function extraeJson(texto) {
  const i = texto.indexOf('{');
  const f = texto.lastIndexOf('}');
  if (i === -1 || f <= i) return null;
  try {
    return JSON.parse(texto.slice(i, f + 1));
  } catch {
    return null;
  }
}

/**
 * Un fallo DEL PROVEEDOR no es un fallo de la versión que se está evaluando.
 *
 * Antes cualquier error reventaba con un stack trace de Node y el CI quedaba
 * rojo como si el prompt hubiera empeorado. Un 429 por límite de cuota y una
 * regresión de calidad son cosas distintas y tienen arreglos distintos: la
 * primera se espera, la segunda se revisa.
 *
 * Se distingue y se dice cuál es.
 */
/**
 * Devuelve el código de salida para un fallo del proveedor.
 *
 * SIEMPRE 0, y esto es deliberado: un límite de cuota o un modelo retirado
 * no tienen nada que ver con el cambio que se está mergeando. Reprobar el CI
 * por eso es fabricar un rojo que nadie puede arreglar desde su PR — y un
 * rojo así se ignora a la tercera vez, que es como se pierde el gate de
 * verdad.
 *
 * Lo que NO hace es callarse: avisa fuerte que el gate no corrió. Es la
 * misma decisión que ya tomaba el script cuando falta la llave — «avisa y se
 * salta, jamás inventa un score».
 *
 * El único exit 1 es el de abajo: el promedio medido quedó bajo el
 * baseline. Ese sí es del cambio.
 */
function explicaFalloDelProveedor(err) {
  const msg = String(err?.message ?? err);
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    console.error(
      'evals: el proveedor limitó la cuota (429). No es una regresión: es el tier.\n' +
        '       En el tier gratis el modelo grande casi no se puede usar de juez.\n' +
        '       Prueba EVAL_JUDGE_MODEL=gemini-flash-latest, o una llave de pago.',
    );
    return 0; // el gate NO corrió; no es un rojo del cambio
  }
  if (/no longer available|NOT_FOUND|404/i.test(msg)) {
    console.error(
      'evals: el modelo no existe para esta llave. Los defaults van por ALIAS\n' +
        '       justamente porque las versiones fijas se retiran (#308).\n' +
        `       Detalle: ${msg.slice(0, 200)}`,
    );
    return 0;
  }
  console.error(`evals: el proveedor falló — ${msg.slice(0, 300)}`);
  console.error('evals: EL GATE NO CORRIÓ. No es un rojo de este cambio.');
  return 0;
}

async function pausaEntreCasos() {
  // Un respiro entre casos: el tier gratis limita por minuto. Configurable
  // para que en una llave de pago no cueste tiempo de más. Acá un 0 sí
  // significa algo: "sin pausa". Pero basura no debe volverse NaN y saltarse
  // la pausa en silencio, que es lo que pasaba.
  const crudo = process.env.EVAL_PAUSA_MS;
  const n = crudo === undefined || crudo.trim() === '' ? 4000 : Number(crudo);
  const pausa = Number.isFinite(n) && n >= 0 ? n : 4000;
  if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
}

/**
 * Corre un dataset contra su prompt REAL y devuelve el promedio.
 *
 * `alJuez` decide qué ve el juez como RESPUESTA: en `sugerir`, el texto de la
 * sugerencia (lo que una persona enviaría); en `autonomo`, el JSON crudo —
 * ahí los criterios hablan de la DECISIÓN (escalar, accion), no solo del
 * texto, y recortarlo sería esconderle al juez justo lo que se evalúa.
 */
async function correrDataset(archivo, prompt, alJuez) {
  const dataset = JSON.parse(readFileSync(join(raiz, 'evals', archivo), 'utf8'));
  let suma = 0;
  for (const caso of dataset.casos) {
    try {
      const gen = await generateText({
        model: candidato,
        system: 'Eres el asistente de ventas por WhatsApp de una pyme chilena. Cercano y profesional.',
        prompt: `${caso.contexto}\n\n${prompt}`,
        // Los modelos que razonan gastan tokens de SALIDA pensando antes de
        // contestar. Una sugerencia de tres líneas consumió 665 en la primera
        // corrida real: con 512 se cortaba a la mitad y el JSON no parseaba.
        maxOutputTokens: 1500,
      });
      const respuesta = alJuez(gen.text);
      const veredicto = await generateText({
        model: juez,
        prompt: `Evalúa esta respuesta de un asistente de pyme chilena.
CONTEXTO: ${caso.contexto}
CRITERIOS: ${caso.criterios.join(' · ')}
RESPUESTA: ${respuesta}
Responde SOLO: {"correctness": <0-1>, "tono": <0-1>, "tools": <0-1>}`,
        // Ídem: con 256 el juez devolvía `{"correctness": 0.8` —cortado— y eso
        // se contaba como un CERO. Un caso perfecto se veía como el peor.
        maxOutputTokens: 1024,
      });
      // Si la nota del juez no se puede leer, ESO no es un cero.
      //
      // Antes caía a `{correctness:0, tono:0, tools:0}`, y un cero por no poder
      // parsear se ve idéntico a un cero por responder pésimo. En la primera
      // corrida de verdad, un caso dio 0.00 y no era la respuesta: era el juez
      // devolviendo algo que no era JSON.
      //
      // Un gate que confunde "no pude medir" con "está mal" hace fallar el CI
      // por un hipo del proveedor, y a la tercera vez nadie lo mira.
      const notas = extraeJson(veredicto.text);
      if (!notas || [notas.correctness, notas.tono, notas.tools].some((n) => !Number.isFinite(Number(n)))) {
        console.error(
          `evals: el juez no devolvió notas legibles para "${caso.id}". No es un cero:\n` +
            `       es que no se pudo medir. Devolvió: ${String(veredicto.text).slice(0, 160)}`,
        );
        console.error('evals: EL GATE NO CORRIÓ. No es un rojo de este cambio.');
        process.exit(0);
      }
      const total = (Number(notas.correctness) * 2 + Number(notas.tono) + Number(notas.tools)) / 4;
      suma += total;
      console.log(`evals: ${dataset.task}/${caso.id} → ${total.toFixed(2)}`);
      await pausaEntreCasos();
    } catch (err) {
      process.exit(explicaFalloDelProveedor(err));
    }
  }
  return { task: dataset.task, promedio: suma / dataset.casos.length };
}

// El catálogo de acciones viaja en los dos prompts, como en el producto
// (#1020 en sugerir, #1030 en autónomo). Sin filtro de módulos: el gate
// evalúa el despliegue completo.
const acciones = accionesParaElPrompt();

const corridas = [
  await correrDataset(
    'dataset-sugerir.json',
    [FORMATO_SUGERENCIA, acciones].filter(Boolean).join('\n\n'),
    (texto) => extraeJson(texto)?.sugerencia ?? texto,
  ),
  await correrDataset(
    'dataset-autonomo.json',
    formatoAutonomo({ moneyLimitClp: null, acciones }),
    (texto) => texto,
  ),
];

let reprobado = false;
for (const { task, promedio } of corridas) {
  const minimo = baseline[task] ?? 0.7;
  console.log(`evals: ${task} promedio ${promedio.toFixed(3)} (baseline ${minimo})`);
  if (promedio < minimo) {
    console.error(`evals: "${task}" RINDE PEOR que el baseline — no pasa (SPEC §13).`);
    reprobado = true;
  }
}
if (reprobado) process.exit(1);
